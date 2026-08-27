import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export type StatusTone = 'success' | 'warning' | 'orange' | 'danger' | 'info' | 'neutral';

/**
 * Maps this app's domain statuses onto the five sanctioned colour pairs.
 *
 * The point of routing every status through one table is that "Failed" and
 * "Rejected" and "Error" can never drift into three different reds across
 * three screens. Anything unrecognised falls to neutral rather than guessing —
 * a wrong colour on a status pill is worse than an uncoloured one, because
 * users read the colour before the word.
 */
const TONE_BY_STATUS: Record<string, StatusTone> = {
  // Terminal success
  completed: 'success',
  complete: 'success',
  saved: 'success',
  matched: 'success',
  reconciled: 'success',
  approved: 'success',
  active: 'success',
  validated: 'success',
  success: 'success',

  // Needs a human
  needs_review: 'warning',
  'needs review': 'warning',
  review: 'warning',
  pending: 'warning',
  partial: 'warning',
  'partially matched': 'warning',
  unmatched: 'warning',

  // In flight
  processing: 'orange',
  extracting: 'orange',
  in_progress: 'orange',
  'in progress': 'orange',
  uploading: 'orange',
  queued: 'orange',

  // Failure
  failed: 'danger',
  error: 'danger',
  rejected: 'danger',
  invalid: 'danger',
  cancelled: 'danger',

  // Informational
  uploaded: 'info',
  new: 'info',
  draft: 'info',
  imported: 'info',
};

@Component({
  selector: 'app-status-badge',
  standalone: true,
  template: `<span class="status-badge" [class]="'status-badge--' + tone()">{{ display() }}</span>`,
  styles: [
    `
      :host {
        display: inline-flex;
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StatusBadgeComponent {
  readonly status = input.required<string>();
  /** Override the derived tone when a screen has domain context the map lacks. */
  readonly toneOverride = input<StatusTone | null>(null);

  protected readonly tone = computed<StatusTone>(
    () => this.toneOverride() ?? TONE_BY_STATUS[this.status()?.toLowerCase().trim()] ?? 'neutral',
  );

  /** snake_case and SCREAMING_CASE both render as readable words. */
  protected readonly display = computed(() => (this.status() ?? '').replace(/[_-]+/g, ' '));
}
