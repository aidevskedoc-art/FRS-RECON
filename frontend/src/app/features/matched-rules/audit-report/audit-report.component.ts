import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { TableModule } from 'primeng/table';
import { MatchedRulesService } from '../../../core/services/matched-rules.service';
import { errorMessage } from '../../../core/services/policy-document.service';
import { AuditDateBasis, AuditPeriodType, AuditReportPreview, AuditReportQuery } from '../../../core/models';

/**
 * The client's deliverable: the "AUDIT WORKING REPORT" workbook for a chosen
 * period. This screen picks the period (Daily / Monthly / Yearly), the date it
 * filters on (MIS receipt date or bank realization date), shows a per-sheet
 * preview, and downloads the .xlsx — laid out exactly as the auditor assembles
 * it by hand today (see backend/src/excel/audit-report.js).
 *
 * Phase 1 covers the three reconciled streams: cheque collection, IP online,
 * Diag online. (The sample's Web Consultations sheet was dropped at the
 * client's request — it duplicated data already covered elsewhere.)
 */
@Component({
  selector: 'app-audit-report',
  standalone: true,
  imports: [FormsModule, ButtonModule, SelectModule, TableModule],
  templateUrl: './audit-report.component.html',
  styleUrl: './audit-report.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AuditReportComponent {
  private readonly matchedRules = inject(MatchedRulesService);

  protected readonly periodType = signal<AuditPeriodType>('MONTHLY');
  protected readonly dateBasis = signal<AuditDateBasis>('RECEIPT');
  /** Held as the raw input shapes; `period()` normalises to what the API wants. */
  protected readonly dayValue = signal(todayIso());
  protected readonly monthValue = signal(todayIso().slice(0, 7));
  protected readonly yearValue = signal(Number(todayIso().slice(0, 4)));
  // Range defaults to the last three months, which is the case this was added
  // for — a quarter that does not line up with one calendar month.
  protected readonly rangeFrom = signal(threeMonthsAgoIso());
  protected readonly rangeTo = signal(todayIso());

  protected readonly loading = signal(false);
  protected readonly downloading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly preview = signal<AuditReportPreview | null>(null);

  protected readonly periodTypeOptions = [
    { label: 'Daily', value: 'DAILY' as const },
    { label: 'Monthly', value: 'MONTHLY' as const },
    { label: 'Yearly', value: 'YEARLY' as const },
    { label: 'Date range', value: 'RANGE' as const },
  ];
  protected readonly dateBasisOptions = [
    { label: 'Receipt Date', value: 'RECEIPT' as const },
    { label: 'Realization Date', value: 'REALIZATION' as const },
  ];

  protected readonly period = computed<string>(() => {
    switch (this.periodType()) {
      case 'DAILY':
        return this.dayValue();
      case 'YEARLY':
        return String(this.yearValue() || '');
      case 'RANGE':
        // The API takes both ends in one `period` value, colon-separated.
        return `${this.rangeFrom()}:${this.rangeTo()}`;
      default:
        return this.monthValue();
    }
  });

  /** Caught here so the range is not sent to the server just to be rejected. */
  protected readonly rangeInvalid = computed(
    () => this.periodType() === 'RANGE' && (!this.rangeFrom() || !this.rangeTo() || this.rangeFrom() > this.rangeTo()),
  );

  protected readonly query = computed<AuditReportQuery>(() => ({
    periodType: this.periodType(),
    period: this.period(),
    dateBasis: this.dateBasis(),
  }));

  protected readonly grandTotals = computed(() => {
    const sheets = this.preview()?.sheets ?? [];
    return {
      rowCount: sheets.reduce((s, x) => s + x.rowCount, 0),
      matched: sheets.reduce((s, x) => s + x.matched, 0),
      contra: sheets.reduce((s, x) => s + x.contra, 0),
      unmatched: sheets.reduce((s, x) => s + x.unmatched, 0),
      totalMisAmount: sheets.reduce((s, x) => s + x.totalMisAmount, 0),
      totalRealizationAmount: sheets.reduce((s, x) => s + x.totalRealizationAmount, 0),
      totalDifference: sheets.reduce((s, x) => s + x.totalDifference, 0),
    };
  });

  constructor() {
    this.loadPreview();
  }

  protected setPeriodType(value: AuditPeriodType): void {
    this.periodType.set(value);
    this.loadPreview();
  }

  protected setDateBasis(value: AuditDateBasis): void {
    this.dateBasis.set(value);
    this.loadPreview();
  }

  protected loadPreview(): void {
    if (!this.period()) return;
    this.loading.set(true);
    this.error.set(null);
    this.matchedRules.fetchAuditReportPreview(this.query()).subscribe({
      next: (preview) => {
        this.preview.set(preview);
        this.loading.set(false);
      },
      error: (err) => {
        this.preview.set(null);
        this.error.set(errorMessage(err));
        this.loading.set(false);
      },
    });
  }

  protected download(variant: 'client' | 'internal' = 'client'): void {
    if (this.downloading() || !this.period()) return;
    this.downloading.set(true);
    this.error.set(null);
    const label = this.preview()?.periodLabel ?? this.period();
    this.matchedRules.downloadAuditReport({ ...this.query(), variant }, label).subscribe({
      next: () => this.downloading.set(false),
      error: (err) => {
        this.error.set(errorMessage(err));
        this.downloading.set(false);
      },
    });
  }

  protected amount(value: number | null | undefined): string {
    return value === null || value === undefined
      ? '—'
      : Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Default start for a range — the common ask is "the last quarter". */
function threeMonthsAgoIso(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - 3);
  return d.toISOString().slice(0, 10);
}
