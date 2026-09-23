import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { PendingChange } from '../../../core/models';

/** AC-16 colour code, as the Mismatch Review table uses it. */
export type DetailTone = 'GREEN' | 'RED' | 'ORANGE';

export interface DetailFieldView {
  readonly label: string;
  /** Already formatted for display; null or '' = empty (hidden until "show empty fields"). */
  readonly value: string | null;
  /** A reference number — monospaced, with a copy button. */
  readonly ref?: boolean;
}

export interface DetailSectionView {
  readonly title: string;
  readonly icon: string;
  readonly fields: readonly DetailFieldView[];
}

/** Everything the record dialog shows — built per collection type by MismatchReviewComponent. */
export interface RecordDetailView {
  readonly typeLabel: string;
  readonly icon: string;
  readonly receiptNo: string;
  readonly status: string | null;
  readonly statusLabel: string;
  readonly tone: DetailTone | null;
  readonly matchedByAuditor: boolean;
  readonly reason: string | null;
  readonly amountLabel: string;
  readonly amount: string | null;
  readonly patientName: string | null;
  /** ISO timestamp or YYYY-MM-DD — formatted here, the same way the table does. */
  readonly receiptDate: string | null;
  readonly location: string | null;
  readonly department: string | null;
  readonly paymentMode: string | null;
  readonly sections: readonly DetailSectionView[];
}

const REASON_TITLE: Record<DetailTone, string> = {
  RED: "Why it didn't match",
  GREEN: 'How it matched',
  ORANGE: 'Approved change',
};

const isFilled = (f: DetailFieldView) => !!f.value && f.value !== '—';

/**
 * The Mismatch Review record dialog's body: a summary header (what, how much,
 * whose, which status), the reason in the status's own colour, then the
 * record's fields grouped into sections. Empty fields are folded away behind
 * one toggle — a Diag/OP row alone has ~25 fields, most blank for any one
 * payment mode. The propose/pending panel is projected in by the parent,
 * which owns the maker-checker flow.
 */
@Component({
  selector: 'app-record-detail',
  standalone: true,
  imports: [DatePipe],
  templateUrl: './record-detail.component.html',
  styleUrl: './record-detail.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RecordDetailComponent {
  readonly detail = input.required<RecordDetailView>();
  readonly pending = input<PendingChange | null>(null);
  readonly closed = output<void>();

  protected readonly showEmpty = signal(false);
  protected readonly copied = signal<string | null>(null);
  private copyTimer: ReturnType<typeof setTimeout> | null = null;

  protected readonly reasonTitle = computed(() => {
    const tone = this.detail().tone;
    return tone ? REASON_TITLE[tone] : 'Status note';
  });

  protected readonly toneClass = computed(() => `tone--${(this.detail().tone ?? 'none').toLowerCase()}`);

  /** Sections with only their filled fields — or every field once "show empty" is on. */
  protected readonly visibleSections = computed(() =>
    this.detail()
      .sections.map((s) => ({ ...s, fields: this.showEmpty() ? s.fields : s.fields.filter(isFilled) }))
      .filter((s) => s.fields.length > 0),
  );

  protected readonly emptyCount = computed(() =>
    this.detail().sections.reduce((n, s) => n + s.fields.filter((f) => !isFilled(f)).length, 0),
  );

  protected isFilled(f: DetailFieldView): boolean {
    return isFilled(f);
  }

  protected copy(value: string): void {
    navigator.clipboard?.writeText(value).then(
      () => {
        this.copied.set(value);
        if (this.copyTimer) clearTimeout(this.copyTimer);
        this.copyTimer = setTimeout(() => this.copied.set(null), 1500);
      },
      () => undefined,
    );
  }
}
