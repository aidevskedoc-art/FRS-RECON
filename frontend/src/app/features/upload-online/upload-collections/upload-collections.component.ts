import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { UploadMisComponent } from '../upload-mis/upload-mis.component';
import { UploadChequeCollectionComponent } from '../upload-cheque-collection/upload-cheque-collection.component';
import { UploadRefundDocumentComponent } from '../upload-refund-document/upload-refund-document.component';

type CollectionTabId = 'mis' | 'cheque' | 'refund';

interface CollectionTab {
  readonly id: CollectionTabId;
  readonly label: string;
  readonly hint: string;
}

/**
 * One upload screen for every collection-side report — MIS payments, cheque
 * collections and the refund document — replacing three separate menu entries.
 * The individual screens are reused verbatim, mounted with `[embedded]="true"`
 * so only this hub renders the page header.
 */
const TABS: readonly CollectionTab[] = [
  { id: 'mis', label: 'MIS Data', hint: 'IP (Format 1) & Diag (Format 2) payment records from the hospital MIS' },
  { id: 'cheque', label: 'Cheque Collection', hint: 'IP or Diagnostics cheque collection export — report detected from the file' },
  { id: 'refund', label: 'Refund Document', hint: 'IP & OP refund details — reference data for contra entries' },
];

@Component({
  selector: 'app-upload-collections',
  standalone: true,
  imports: [UploadMisComponent, UploadChequeCollectionComponent, UploadRefundDocumentComponent],
  templateUrl: './upload-collections.component.html',
  styleUrl: './upload-collections.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UploadCollectionsComponent {
  protected readonly tabs = TABS;
  protected readonly active = signal<CollectionTabId>(TABS[0].id);

  constructor() {
    // A `?tab=` hint (from a "Upload" button on a list screen) opens the hub on
    // the right report; anything unrecognised falls back to the first tab.
    const requested = inject(ActivatedRoute).snapshot.queryParamMap.get('tab');
    if (requested && TABS.some((t) => t.id === requested)) {
      this.active.set(requested as CollectionTabId);
    }
  }

  protected select(id: CollectionTabId): void {
    this.active.set(id);
  }
}
