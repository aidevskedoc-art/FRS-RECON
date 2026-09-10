import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TooltipModule } from 'primeng/tooltip';
import { ChequeCollectionService } from '../../../core/services/cheque-collection.service';
import { errorMessage } from '../../../core/services/policy-document.service';
import { ChequeCollectionKind } from '../../../core/models';

@Component({
  selector: 'app-view-cheque-collections',
  standalone: true,
  imports: [RouterLink, DatePipe, ButtonModule, TableModule, TooltipModule],
  templateUrl: './view-cheque-collections.component.html',
  styleUrl: './view-cheque-collections.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ViewChequeCollectionsComponent {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  protected readonly chequeCollections = inject(ChequeCollectionService);

  /**
   * Which report this page lists, from the route. One component serves both
   * screens: the two differ only in which kind they show, and the service
   * caches every batch in one signal, so filtering here keeps a single fetch
   * rather than two pages racing to refill the same cache.
   */
  protected readonly kind: ChequeCollectionKind = this.route.snapshot.data['collectionKind'] ?? 'IP';
  protected readonly isDiagnostics = this.kind === 'OP';
  protected readonly heading = this.isDiagnostics ? 'Diagnostics Cheque Collections' : 'IP Cheque Collections';

  protected readonly batches = computed(() =>
    this.chequeCollections.batches().filter((b) => (b.collectionKind ?? 'IP') === this.kind),
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
