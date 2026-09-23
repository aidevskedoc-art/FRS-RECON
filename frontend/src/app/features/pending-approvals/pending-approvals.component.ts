import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { DialogModule } from 'primeng/dialog';
import { MatchApprovalService } from '../../core/services/match-approval.service';
import { errorMessage } from '../../core/services/policy-document.service';
import { MatchChangeRequest } from '../../core/models';
import { PageHeaderComponent } from '../../shared/ui/page-header.component';

type TabId = 'toReview' | 'mine';

interface ApprovalsTab {
  readonly id: TabId;
  readonly label: string;
  readonly icon: string;
}

const TABS: readonly ApprovalsTab[] = [
  { id: 'toReview', label: 'To Review', icon: 'pi pi-inbox' },
  { id: 'mine', label: 'My Requests', icon: 'pi pi-send' },
];

function amountText(value: number | null | undefined): string {
  return value === null || value === undefined
    ? '—'
    : `₹${Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * The checker's side of maker-checker (client mail 2026-09-21, point 2).
 * "To Review" is my own queue — requests from Auditors who report to me
 * (users.manager_id). "My Requests" lets a maker see the status of what
 * they've proposed. Not role-gated: any real user could be someone's
 * Reporting Manager, not only Admin, and any Auditor has their own requests
 * to check on — both tabs are simply empty when there's nothing to show.
 */
@Component({
  selector: 'app-pending-approvals',
  standalone: true,
  imports: [DatePipe, FormsModule, DialogModule, PageHeaderComponent],
  templateUrl: './pending-approvals.component.html',
  styleUrl: './pending-approvals.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PendingApprovalsComponent {
  protected readonly matchApproval = inject(MatchApprovalService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly tabs = TABS;
  protected readonly activeTab = signal<TabId>(this.initialTab());
  protected readonly listError = signal<string | null>(null);
  protected readonly loading = signal(false);

  // ---- review dialog (approve/reject) -------------------------------------------------
  protected readonly reviewingRequest = signal<MatchChangeRequest | null>(null);
  protected readonly reviewNote = signal('');
  protected readonly reviewSaving = signal(false);
  protected readonly reviewError = signal<string | null>(null);

  // ---- bulk approve/reject — checker multi-select on the To Review queue (client ask, 2026-09-23) ----
  protected readonly selectedRequests = signal<MatchChangeRequest[]>([]);
  protected readonly bulkReviewOpen = signal(false);
  protected readonly bulkReviewAction = signal<'approve' | 'reject'>('approve');
  protected readonly bulkReviewNote = signal('');
  protected readonly bulkReviewSaving = signal(false);
  protected readonly bulkReviewError = signal<string | null>(null);
  protected readonly bulkReviewProgress = signal<{ done: number; total: number } | null>(null);
  protected readonly bulkReviewResultMessage = signal<string | null>(null);

  constructor() {
    this.load(this.activeTab());
  }

  private initialTab(): TabId {
    const tab = this.route.snapshot.queryParamMap.get('tab');
    return TABS.some((t) => t.id === tab) ? (tab as TabId) : TABS[0].id;
  }

  protected selectTab(id: TabId): void {
    this.activeTab.set(id);
    this.router.navigate([], { queryParams: { tab: id }, queryParamsHandling: 'merge', relativeTo: this.route });
    this.load(id);
  }

  private load(tab: TabId): void {
    this.loading.set(true);
    this.listError.set(null);
    // The queue that's about to change — any bulk selection from it goes stale.
    this.selectedRequests.set([]);
    const request = tab === 'toReview' ? this.matchApproval.refreshToReview('PENDING') : this.matchApproval.refreshMine();
    request.subscribe({
      next: () => this.loading.set(false),
      error: (err) => { this.loading.set(false); this.listError.set(errorMessage(err)); },
    });
  }

  protected amount(value: number | null | undefined): string {
    return amountText(value);
  }

  protected statusPillClass(status: string): string {
    if (status === 'PENDING') return 'status-pill--pending';
    if (status === 'APPROVED') return 'status-pill--approved';
    return 'status-pill--rejected';
  }

  /**
   * Client mail item 15 — a CORRECTION unlocks + resets a locked system
   * match to Unmatched, materially different from a MATCH_PROPOSAL (which
   * locks a mismatch as Matched). The reviewer needs to know which they're
   * being asked to approve.
   */
  protected requestKindLabel(kind: string): string {
    return kind === 'CORRECTION' ? 'Correction' : 'Propose Match';
  }

  // ---- review (approve / reject) -----------------------------------------------------

  protected openReview(request: MatchChangeRequest): void {
    this.reviewingRequest.set(request);
    this.reviewNote.set('');
    this.reviewError.set(null);
    this.reviewSaving.set(false);
  }

  protected closeReview(): void {
    this.reviewingRequest.set(null);
  }

  protected approve(): void {
    const request = this.reviewingRequest();
    if (!request) return;
    this.reviewSaving.set(true);
    this.reviewError.set(null);
    this.matchApproval.approve(request.id, this.reviewNote().trim() || undefined).subscribe({
      next: () => {
        this.reviewSaving.set(false);
        this.reviewingRequest.set(null);
        this.load('toReview');
      },
      error: (err) => {
        this.reviewSaving.set(false);
        this.reviewError.set(errorMessage(err));
      },
    });
  }

  protected reject(): void {
    const request = this.reviewingRequest();
    if (!request) return;
    if (!this.reviewNote().trim()) {
      this.reviewError.set('A note is required when rejecting.');
      return;
    }
    this.reviewSaving.set(true);
    this.reviewError.set(null);
    this.matchApproval.reject(request.id, this.reviewNote().trim()).subscribe({
      next: () => {
        this.reviewSaving.set(false);
        this.reviewingRequest.set(null);
        this.load('toReview');
      },
      error: (err) => {
        this.reviewSaving.set(false);
        this.reviewError.set(errorMessage(err));
      },
    });
  }

  // ---- bulk approve/reject — checker multi-select (client ask, 2026-09-23) -----------

  protected isSelected(req: MatchChangeRequest): boolean {
    return this.selectedRequests().some((r) => r.id === req.id);
  }

  /** Kept off the row's own click (which opens single review) via stopPropagation in the template. */
  protected toggleSelect(req: MatchChangeRequest): void {
    this.selectedRequests.update((rows) =>
      rows.some((r) => r.id === req.id) ? rows.filter((r) => r.id !== req.id) : [...rows, req],
    );
  }

  protected clearSelection(): void {
    this.selectedRequests.set([]);
  }

  protected openBulkReview(action: 'approve' | 'reject'): void {
    if (this.selectedRequests().length === 0) return;
    this.bulkReviewAction.set(action);
    this.bulkReviewOpen.set(true);
    this.bulkReviewNote.set('');
    this.bulkReviewError.set(null);
    this.bulkReviewResultMessage.set(null);
  }

  /** Blocked while a batch is running — closing mid-run would leave its outcome unseen. */
  protected closeBulkReview(): void {
    if (this.bulkReviewProgress()) return;
    this.bulkReviewOpen.set(false);
  }

  /**
   * One approve/reject call per selected request, sequential so the dialog
   * can show real "N of M" progress and one request's failure (e.g. someone
   * else already reviewed it) doesn't stop the rest of the batch.
   */
  protected submitBulkReview(): void {
    const action = this.bulkReviewAction();
    const note = this.bulkReviewNote().trim();
    if (action === 'reject' && !note) {
      this.bulkReviewError.set('A note is required when rejecting.');
      return;
    }
    const requests = this.selectedRequests();
    if (requests.length === 0) return;
    this.bulkReviewError.set(null);
    this.bulkReviewResultMessage.set(null);
    this.bulkReviewProgress.set({ done: 0, total: requests.length });
    let succeeded = 0;
    const failures: string[] = [];
    const verb = action === 'approve' ? 'approved' : 'rejected';

    const runNext = (index: number): void => {
      if (index >= requests.length) {
        this.bulkReviewProgress.set(null);
        this.bulkReviewResultMessage.set(
          failures.length === 0
            ? `${succeeded} of ${requests.length} ${verb}.`
            : `${succeeded} of ${requests.length} ${verb}. ${failures.length} failed: ${failures.slice(0, 3).join('; ')}${failures.length > 3 ? '…' : ''}`,
        );
        this.load('toReview');
        return;
      }
      const req = requests[index];
      const call = action === 'approve' ? this.matchApproval.approve(req.id, note || undefined) : this.matchApproval.reject(req.id, note);
      call.subscribe({
        next: () => {
          succeeded++;
          this.bulkReviewProgress.set({ done: index + 1, total: requests.length });
          runNext(index + 1);
        },
        error: (err) => {
          failures.push(`${req.record?.receiptNumber || req.id}: ${errorMessage(err)}`);
          this.bulkReviewProgress.set({ done: index + 1, total: requests.length });
          runNext(index + 1);
        },
      });
    };
    runNext(0);
  }
}
