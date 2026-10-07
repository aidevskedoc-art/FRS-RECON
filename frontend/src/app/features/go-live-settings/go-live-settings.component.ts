import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DatePickerModule } from 'primeng/datepicker';
import { InputNumberModule } from 'primeng/inputnumber';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { GoLiveService } from '../../core/services/go-live.service';
import { errorMessage } from '../../core/utils/error-message.util';
import { AwaitingStatementSetting, GoLiveConfig, GoLiveConfigDraft } from '../../core/models';
import { PageHeaderComponent } from '../../shared/ui/page-header.component';

/** Local calendar date -> 'YYYY-MM-DD' (see frs-date-timezone-trap — never through toISOString). */
function toDateOnly(d: Date | null): string | null {
  if (!d) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 'YYYY-MM-DD' -> a local-midnight Date, built from its own components — never `new Date(str)`, which parses as UTC and can land a day off (frs-date-timezone-trap). */
function fromDateOnly(ymd: string | null): Date | null {
  const m = ymd ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd) : null;
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

interface Draft {
  cutoffDate: Date | null;
  active: boolean;
}

function emptyDraft(): Draft {
  // The client's own stated date (2026-09-21 mail) — matches the schema
  // migration's seed, so a first-time save without changing anything still
  // lands on what they asked for.
  return { cutoffDate: fromDateOnly('2026-10-01'), active: true };
}

/**
 * Client mail items 8 & 15 (2026-09-21) — the one switch behind both "every
 * match, system or auditor, gets locked" and "nobody can edit MIS/bank data"
 * from go-live. `active` is the emergency brake if the date needs to slip
 * without a code change — see backend/src/go-live.js.
 */
@Component({
  selector: 'app-go-live-settings',
  standalone: true,
  imports: [DatePipe, FormsModule, DatePickerModule, InputNumberModule, ToggleSwitchModule, PageHeaderComponent],
  templateUrl: './go-live-settings.component.html',
  styleUrl: './go-live-settings.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GoLiveSettingsComponent {
  protected readonly goLive = inject(GoLiveService);

  protected readonly draft = signal<Draft>(emptyDraft());
  protected readonly loadError = signal<string | null>(null);
  protected readonly formError = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly saved = signal(false);

  /** Whether today (IST) is on/after the picked date — the same rule backend's isPastGoLive() applies, so the screen can say what's actually in effect right now. */
  protected readonly isPastCutoff = computed(() => {
    const cutoff = this.draft().cutoffDate;
    if (!cutoff) return false;
    const today = new Date();
    const todayYmd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    return todayYmd >= toDateOnly(cutoff)!;
  });

  // ---- Awaiting statement allowance ----------------------------------------------------
  protected readonly awaiting = signal<AwaitingStatementSetting | null>(null);
  protected readonly awaitingDays = signal<number>(3);
  protected readonly awaitingError = signal<string | null>(null);
  protected readonly awaitingSaving = signal(false);
  protected readonly awaitingSaved = signal(false);

  constructor() {
    this.goLive.refreshConfig().subscribe({
      next: (config) => { if (config) this.draft.set(this.toDraft(config)); },
      error: (err) => this.loadError.set(errorMessage(err)),
    });
    this.goLive.fetchAwaitingSetting().subscribe({
      next: (s) => {
        this.awaiting.set(s);
        this.awaitingDays.set(s.awaitingStatementDays);
      },
      error: (err) => this.awaitingError.set(errorMessage(err)),
    });
  }

  protected setAwaitingDays(value: number | null): void {
    this.awaitingDays.set(value ?? 0);
    this.awaitingSaved.set(false);
  }

  protected saveAwaiting(): void {
    this.awaitingSaving.set(true);
    this.awaitingError.set(null);
    this.goLive.saveAwaitingSetting(this.awaitingDays()).subscribe({
      next: (s) => {
        this.awaiting.set(s);
        this.awaitingSaving.set(false);
        this.awaitingSaved.set(true);
      },
      error: (err) => {
        this.awaitingSaving.set(false);
        this.awaitingError.set(errorMessage(err));
      },
    });
  }

  private toDraft(config: GoLiveConfig): Draft {
    return { cutoffDate: fromDateOnly(config.cutoffDate), active: config.active };
  }

  protected updateDraft(patch: Partial<Draft>): void {
    this.draft.update((d) => ({ ...d, ...patch }));
    this.saved.set(false);
  }

  protected save(): void {
    const d = this.draft();
    const cutoffDate = toDateOnly(d.cutoffDate);
    if (!cutoffDate) return this.formError.set('A cutoff date is required');

    const draft: GoLiveConfigDraft = { cutoffDate, active: d.active };
    this.saving.set(true);
    this.formError.set(null);
    this.goLive.saveConfig(draft).subscribe({
      next: () => {
        this.saving.set(false);
        this.saved.set(true);
      },
      error: (err) => {
        this.saving.set(false);
        this.formError.set(errorMessage(err));
      },
    });
  }
}
