import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Router } from '@angular/router';
import { TableModule } from 'primeng/table';
import { TooltipModule } from 'primeng/tooltip';
import { ChequeCollectionService } from '../../../core/services/cheque-collection.service';
import { errorMessage } from '../../../core/services/policy-document.service';
import { ChequeCollectionKind } from '../../../core/models';

@Component({
  selector: 'app-view-cheque-collections',
  standalone: true,
  imports: [DatePipe, TableModule, TooltipModule],
  templateUrl: './view-cheque-collections.component.html',
  styleUrl: './view-cheque-collections.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ViewChequeCollectionsComponent {
  private readonly router = inject(Router);
  protected readonly chequeCollections = inject(ChequeCollectionService);

  /**
   * Which report this tab lists. One component serves both — the two differ
   * only in which kind they show, and the service caches every batch in one
   * signal, so filtering here keeps a single fetch rather than two tabs
   * racing to refill the same cache.
   */
  readonly kind = input<ChequeCollectionKind>('IP', { alias: 'collectionKind' });
  protected readonly isDiagnostics = computed(() => this.kind() === 'OP');
  protected readonly heading = computed(() =>
    this.isDiagnostics() ? 'Diagnostics Cheque Collections' : 'IP Cheque Collections',
  );

  protected readonly batches = computed(() =>
    this.chequeCollections.batches().filter((b) => (b.collectionKind ?? 'IP') === this.kind()),
  );

  protected readonly deletingId = signal<string | null>(null);
  protected readonly deleteError = signal<string | null>(null);

  constructor() {
    this.chequeCollections.refreshBatches().subscribe({ error: () => {} });
  }

  protected view(batchId: string): void {
    this.router.navigate(['/upload-online/cheque-collections', batchId]);
  }

  protected deleteBatch(batchId: string): void {
    if (this.deletingId()) return;
    this.deletingId.set(batchId);
    this.deleteError.set(null);
    this.chequeCollections.deleteBatch(batchId).subscribe({
      next: () => this.deletingId.set(null),
      error: (err) => {
        this.deletingId.set(null);
        this.deleteError.set(errorMessage(err));
      },
    });
  }
}
