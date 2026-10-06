import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { ChartModule } from 'primeng/chart';
import { TooltipModule } from 'primeng/tooltip';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { MatchedRulesService } from '../../core/services/matched-rules.service';
import { MismatchReviewService } from '../../core/services/mismatch-review.service';
import { MatchApprovalService } from '../../core/services/match-approval.service';
import { FolderWatchService } from '../../core/services/folder-watch.service';
import { AuthService } from '../../core/services/auth.service';
import { ThemeStore } from '../../core/state/theme.store';
import { CHART_PALETTES, resolveTheme } from '../../core/config/palette';
import { errorMessage } from '../../core/services/policy-document.service';
import {
  CollectionFreshness,
  FolderWatchRun,
  PaymentTypeSummary,
  ReconciliationDates,
  ReconciliationSummary,
} from '../../core/models';
import { PageHeaderComponent } from '../../shared/ui/page-header.component';
import { SummaryPanelComponent } from '../reconciliation/summary-panel/summary-panel.component';

type FlowKey = 'online' | 'cheque' | 'card' | 'upi';

/** The verdict buckets every per-type summary shares — enough to compute "reconciled" and "needs attention". */
interface Verdicts {
  total: number;
  totalAmount: number;
  reconciled: number;
  attention: number;
  excluded: number;
  notGenerated: number;
  /** Of `reconciled`: Card / UPI receipts matched as a group against one gateway row. */
  grouped: number;
}

interface FlowStep {
  label: string;
  value: string;
  sub: string;
  state: 'done' | 'missing' | 'warn' | 'ok';
}

interface FlowLane {
  key: FlowKey;
  label: string;
  icon: string;
  steps: FlowStep[];
  attention: number;
  rate: number | null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'YYYY-MM-DD' -> '15 Sep 2026', by string — never through a Date, which can land a day early (frs-date-timezone-trap). */
function calendarDateText(ymd: string | null | undefined): string | null {
  const m = ymd ? /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd) : null;
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : null;
}

/** Indian short form for a hero tile — ₹4.2 Cr / ₹12.6 L / ₹84,500. */
function compactRupees(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const v = Number(value);
  if (Math.abs(v) >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`;
  if (Math.abs(v) >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`;
  return `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

function verdicts(s: PaymentTypeSummary & { notGenerated?: number; groupedMatched?: number }): Verdicts {
  return {
    total: s.total,
    totalAmount: s.totalAmount,
    reconciled: s.matched + s.easebuzzMatched + s.contra,
    attention: s.partialMatch + s.mismatched + s.unmatched + s.ambiguous,
    excluded: s.excluded,
    notGenerated: s.notGenerated ?? 0,
    grouped: s.groupedMatched ?? 0,
  };
}

function addVerdicts(a: Verdicts, b: Verdicts): Verdicts {
  return {
    total: a.total + b.total,
    totalAmount: a.totalAmount + b.totalAmount,
    reconciled: a.reconciled + b.reconciled,
    attention: a.attention + b.attention,
    excluded: a.excluded + b.excluded,
    notGenerated: a.notGenerated + b.notGenerated,
    grouped: a.grouped + b.grouped,
  };
}

/** Reconciled share of what is actually in scope (excluded rows don't count either way). */
function rate(v: Verdicts): number | null {
  const inScope = v.total - v.excluded;
  return inScope > 0 ? Math.round((v.reconciled / inScope) * 1000) / 10 : null;
}

const LANES: readonly { key: FlowKey; label: string; icon: string }[] = [
  { key: 'online', label: 'Online (IP + Diag/OP)', icon: 'pi pi-globe' },
  { key: 'cheque', label: 'Cheque', icon: 'pi pi-file' },
  { key: 'card', label: 'Card', icon: 'pi pi-credit-card' },
  { key: 'upi', label: 'UPI', icon: 'pi pi-mobile' },
];

/**
 * The overview dashboard — the landing page for every signed-in user
 * (enhancement 2026-09-21, item 1: "all data, what is doing, what is the flow,
 * with graphical view"). Never screen-gated, so it's also where a denied URL
 * lands.
 *
 * No new backend: everything is read from the endpoints the other screens
 * already use — /matched-rules/summary (every verdict count and amount),
 * /matched-rules/reconciliation-dates (the MIS → bank flow per collection type),
 * the maker-checker queue, and (Admins only — its API is Admin-only) the
 * shared-folder automation's recent runs.
 *
 * Status charts use the client's own green / amber / red colour code, never the
 * brand purple/orange, so the dashboard can't contradict the status pills; the
 * brand pair drives the category chart and the page chrome.
 */
@Component({
  selector: 'app-overview-dashboard',
  standalone: true,
  imports: [DatePipe, RouterLink, ChartModule, TooltipModule, PageHeaderComponent, SummaryPanelComponent],
  templateUrl: './overview-dashboard.component.html',
  styleUrl: './overview-dashboard.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OverviewDashboardComponent {
  private readonly matchedRules = inject(MatchedRulesService);
  private readonly mismatchReview = inject(MismatchReviewService);
  private readonly matchApproval = inject(MatchApprovalService);
  private readonly folderWatch = inject(FolderWatchService);
  private readonly themeStore = inject(ThemeStore);
  protected readonly auth = inject(AuthService);

  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly summary = signal<ReconciliationSummary | null>(null);
  protected readonly dates = signal<ReconciliationDates | null>(null);
  protected readonly pendingApprovals = signal<number | null>(null);
  protected readonly recentRuns = signal<FolderWatchRun[] | null>(null);
  protected readonly loadedAt = signal<Date | null>(null);

  protected readonly lanes = LANES;

  private readonly palette = computed(() => CHART_PALETTES[resolveTheme(this.themeStore.mode())]);

  // ---- hero numbers ------------------------------------------------------------------

  private readonly overall = computed<Verdicts | null>(() => {
    const s = this.summary();
    if (!s) return null;
    const c = s.combined;
    return {
      total: c.totalTransactions,
      totalAmount: c.totalAmount,
      reconciled: c.totalMatched + c.totalEasebuzzMatched + c.totalContra,
      attention: c.totalPartialMatch + c.totalMismatched + c.totalUnmatched + c.totalAmbiguous,
      excluded: c.totalExcluded,
      notGenerated: s.cardPayments.notGenerated + s.upiGatewayPayments.notGenerated,
      grouped: (s.cardPayments.groupedMatched ?? 0) + (s.upiGatewayPayments.groupedMatched ?? 0),
    };
  });

  protected readonly reconciledRate = computed(() => {
    const v = this.overall();
    return v ? rate(v) : null;
  });

  protected readonly attention = computed(() => this.overall()?.attention ?? null);
  protected readonly totalTransactions = computed(() => this.overall()?.total ?? null);
  protected readonly collectionValue = computed(() => compactRupees(this.summary()?.combined.totalAmount));
  protected readonly balanceValue = computed(() => compactRupees(this.summary()?.combined.balanceAmount));

  /** How far the bank data runs — the ceiling on what could possibly be reconciled yet. */
  protected readonly bankUpTo = computed(() => {
    const bank = this.dates()?.online.bank;
    return calendarDateText(bank?.overallDataUpTo ?? bank?.dataUpTo ?? null);
  });

  protected readonly misUpTo = computed(() => calendarDateText(this.dates()?.online.mis.dataUpTo ?? null));

  // ---- the flow: MIS -> bank/MPR -> reconciled -> to review, per collection type ----

  private readonly perType = computed<Record<FlowKey, Verdicts> | null>(() => {
    const s = this.summary();
    if (!s) return null;
    return {
      online: addVerdicts(verdicts(s.ipPayments), verdicts(s.diagPayments)),
      cheque: verdicts(s.chequePayments),
      card: verdicts(s.cardPayments),
      upi: verdicts(s.upiGatewayPayments),
    };
  });

  protected readonly flow = computed<FlowLane[]>(() => {
    const types = this.perType();
    const dates = this.dates();
    return LANES.map((lane) => {
      const v = types?.[lane.key] ?? null;
      const d: CollectionFreshness | null = dates?.[lane.key] ?? null;
      const misDate = calendarDateText(d?.mis.dataUpTo);
      const bankDate = calendarDateText(d?.bank.overallDataUpTo ?? d?.bank.dataUpTo);
      const r = v ? rate(v) : null;
      const steps: FlowStep[] = [
        {
          label: 'MIS data',
          value: misDate ? `up to ${misDate}` : 'Not uploaded',
          sub: d?.mis.uploadedAt ? 'uploaded' : 'waiting for the MIS file',
          state: misDate ? 'done' : 'missing',
        },
        {
          label: d?.bank.source ?? 'Bank / MPR',
          value: bankDate ? `up to ${bankDate}` : 'Not uploaded',
          sub: d?.bank.uploadedAt ? 'uploaded' : 'nothing to match against yet',
          state: bankDate ? 'done' : 'missing',
        },
        {
          label: 'Reconciled',
          value: r === null ? '—' : `${r}%`,
          // "1,417 of 1,417 · 386 grouped": receipts matched together against one
          // gateway row are reconciled, and said so — a bare "1,031 of 1,417" left
          // the rest looking unaccounted for.
          sub: v
            ? `${v.reconciled.toLocaleString('en-IN')} of ${(v.total - v.excluded).toLocaleString('en-IN')}` +
              (v.grouped > 0 ? ` · ${v.grouped.toLocaleString('en-IN')} grouped` : '')
            : '',
          state: r === null ? 'missing' : r >= 95 ? 'ok' : 'warn',
        },
        {
          label: 'To review',
          value: v ? v.attention.toLocaleString('en-IN') : '—',
          sub: v && v.notGenerated > 0 ? `${v.notGenerated.toLocaleString('en-IN')} not yet generated` : 'mismatches',
          state: !v ? 'missing' : v.attention === 0 && v.notGenerated === 0 ? 'ok' : 'warn',
        },
      ];
      return { ...lane, steps, attention: v?.attention ?? 0, rate: r };
    });
  });

  // ---- charts ---------------------------------------------------------------------

  /** Every verdict, in the client's colour code: green reconciled, amber partial/mismatch, red unmatched, grey exceptions. */
  protected readonly statusChart = computed(() => {
    const s = this.summary();
    if (!s) return null;
    const c = s.combined;
    const p = this.palette();
    return {
      // Same wording as the screens and the Excel files (STATUS_LABELS) — a chart
      // slice that says something different from the table under it invites a query.
      labels: ['Matched', 'Gateway Matched', 'Contra', 'Partial Match', 'Amount Mismatch', 'Unmatched', 'Multiple Matches Found'],
      datasets: [
        {
          data: [c.totalMatched, c.totalEasebuzzMatched, c.totalContra, c.totalPartialMatch, c.totalMismatched, c.totalUnmatched, c.totalAmbiguous],
          backgroundColor: [p.matched, lighten(p.matched), lighten(p.matched, 0.55), p.mismatch, lighten(p.mismatch, 0.2), p.unmatched, p.neutral],
          borderWidth: 0,
          hoverOffset: 6,
        },
      ],
    };
  });

  /** Reconciled vs needs-attention per collection type — the same verdict split as the status chart. */
  protected readonly typeChart = computed(() => {
    const s = this.summary();
    if (!s) return null;
    const p = this.palette();
    const rows: [string, PaymentTypeSummary][] = [
      ['IP', s.ipPayments],
      ['Diag / OP', s.diagPayments],
      ['UPI (bank)', s.upiPayments],
      ['Cheque', s.chequePayments],
      ['Card', s.cardPayments],
      ['UPI (gateway)', s.upiGatewayPayments],
    ];
    return {
      labels: rows.map(([name]) => name),
      datasets: [
        { label: 'Reconciled', data: rows.map(([, d]) => d.matched + d.easebuzzMatched + d.contra), backgroundColor: p.matched, borderRadius: 4 },
        { label: 'Mismatch / partial', data: rows.map(([, d]) => d.mismatched + d.partialMatch + d.ambiguous), backgroundColor: p.mismatch, borderRadius: 4 },
        { label: 'Unmatched', data: rows.map(([, d]) => d.unmatched), backgroundColor: p.unmatched, borderRadius: 4 },
      ],
    };
  });

  /** Where the money comes from — categories, not verdicts, so this one wears the brand purple/orange. */
  protected readonly valueChart = computed(() => {
    const s = this.summary();
    if (!s) return null;
    const p = this.palette();
    const rows: [string, number][] = [
      ['IP', s.ipPayments.totalAmount],
      ['Diag / OP', s.diagPayments.totalAmount],
      ['Cheque', s.chequePayments.totalAmount],
      ['Card', s.cardPayments.totalAmount],
      ['UPI (gateway)', s.upiGatewayPayments.totalAmount],
    ];
    return {
      labels: rows.map(([name]) => name),
      datasets: [{ data: rows.map(([, amount]) => amount), backgroundColor: p.series.slice(0, rows.length), borderWidth: 0, hoverOffset: 6 }],
    };
  });

  protected readonly doughnutOptions = computed(() => {
    const p = this.palette();
    return {
      maintainAspectRatio: false,
      cutout: '68%',
      plugins: {
        legend: { position: 'right', labels: { color: p.axis, boxWidth: 10, boxHeight: 10, usePointStyle: true, padding: 10 } },
        tooltip: { backgroundColor: p.tooltipBg, borderColor: p.tooltipBorder, borderWidth: 1, titleColor: p.tooltipText, bodyColor: p.tooltipText },
      },
    };
  });

  protected readonly valueOptions = computed(() => {
    const base = this.doughnutOptions();
    return {
      ...base,
      plugins: {
        ...base.plugins,
        tooltip: {
          ...base.plugins.tooltip,
          callbacks: { label: (ctx: { label: string; parsed: number }) => `${ctx.label}: ${compactRupees(ctx.parsed)}` },
        },
      },
    };
  });

  protected readonly barOptions = computed(() => {
    const p = this.palette();
    return {
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'top', align: 'end', labels: { color: p.axis, boxWidth: 10, boxHeight: 10, usePointStyle: true } },
        tooltip: { backgroundColor: p.tooltipBg, borderColor: p.tooltipBorder, borderWidth: 1, titleColor: p.tooltipText, bodyColor: p.tooltipText },
      },
      scales: {
        x: { stacked: true, ticks: { color: p.axis }, grid: { display: false } },
        y: { stacked: true, ticks: { color: p.axis }, grid: { color: p.grid } },
      },
    };
  });

  // ---- settlement & gateway ----------------------------------------------------------

  protected readonly settlementRows = computed(() => {
    const s = this.summary();
    if (!s) return [];
    return [
      { name: 'Bank Statement', d: s.bankStatement, unmatchedLabel: 'only in bank' },
      { name: 'PayU MPR', d: s.payuMpr, unmatchedLabel: 'only in MPR' },
      { name: 'EaseBuzz', d: s.easebuzz, unmatchedLabel: 'only in EaseBuzz' },
    ];
  });

  constructor() {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.error.set(null);
    const isAdmin = this.auth.isFrsAdmin();
    forkJoin({
      summary: this.matchedRules.fetchSummary({}),
      dates: this.mismatchReview.fetchReconciliationDates({}).pipe(catchError(() => of(null))),
      approvals: this.matchApproval.refreshToReview('PENDING').pipe(catchError(() => of(null))),
      // The automation's API is Admin-only; an Auditor just doesn't get this panel.
      runs: isAdmin ? this.folderWatch.refreshRuns(1, 5).pipe(catchError(() => of(null))) : of(null),
    }).subscribe({
      next: ({ summary, dates, approvals, runs }) => {
        this.summary.set(summary);
        this.dates.set(dates);
        this.pendingApprovals.set(approvals ? approvals.length : null);
        this.recentRuns.set(runs ? runs.runs : null);
        this.loadedAt.set(new Date());
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(errorMessage(err));
        this.loading.set(false);
      },
    });
  }

  protected can(screenKey: string): boolean {
    return this.auth.hasScreenAccess(screenKey);
  }

  protected count(value: number | null | undefined): string {
    return value === null || value === undefined ? '—' : Number(value).toLocaleString('en-IN');
  }

  protected rupees(value: number | null | undefined): string {
    return compactRupees(value);
  }

  protected runStatusClass(status: string): string {
    if (status === 'COMPLETED') return 'run-pill--ok';
    if (status === 'FAILED') return 'run-pill--bad';
    return 'run-pill--busy';
  }
}

/** Mixes a hex colour toward white — a lighter shade of the same status family for its sub-buckets. */
function lighten(hex: string, amount = 0.35): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  const mix = (c: string) => Math.round(parseInt(c, 16) + (255 - parseInt(c, 16)) * amount);
  return `rgb(${mix(m[1])}, ${mix(m[2])}, ${mix(m[3])})`;
}
