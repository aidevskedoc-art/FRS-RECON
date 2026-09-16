import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { UploadUcrIpComponent } from '../upload-ucr-ip/upload-ucr-ip.component';
import { UploadUcrOpComponent } from '../upload-ucr-op/upload-ucr-op.component';
import { UploadUcrDiagComponent } from '../upload-ucr-diag/upload-ucr-diag.component';
import { UploadCardMprComponent } from '../upload-card-mpr/upload-card-mpr.component';
import { UploadCardPinelabsComponent } from '../upload-card-pinelabs/upload-card-pinelabs.component';
import { UploadUpiMprComponent } from '../upload-upi-mpr/upload-upi-mpr.component';

type UcrFeedTabId = 'ucr-ip' | 'ucr-op' | 'ucr-diag' | 'card-mpr' | 'card-pinelabs' | 'upi-mpr';

interface UcrFeedTab {
  readonly id: UcrFeedTabId;
  readonly label: string;
  readonly hint: string;
}

/**
 * One upload screen for every UPI & Card Reconciliation feed — the
 * instrument-level MIS export plus the three gateway/processor reports.
 * Wholly separate module from Upload Bank & Gateway Feeds (see
 * ucr-upload.service.ts's header comment). The individual screens are reused
 * verbatim, mounted with `[embedded]="true"` so only this hub renders the
 * page header — same pattern as upload-bank-feeds.component.ts.
 */
const TABS: readonly UcrFeedTab[] = [
  { id: 'ucr-ip', label: 'MIS (IP)', hint: 'Instrument-level IP export — one row per Card/UPI payment, with its own Reference ID' },
  { id: 'ucr-op', label: 'MIS (OP)', hint: 'OP doctor consultations export — Card/UPI reference id per receipt' },
  { id: 'ucr-diag', label: 'MIS (DIAG)', hint: 'DIAG advances export — Card pathway only (see the upload screen for why)' },
  { id: 'card-mpr', label: 'CARD MPR', hint: 'Bank/processor Card Merchant Payout Report — approval code, gross amount' },
  { id: 'card-pinelabs', label: 'Pine Labs (AMEX)', hint: 'Pine Labs POS export — multiple card networks/acquirers in one file' },
  { id: 'upi-mpr', label: 'UPI MPR', hint: 'UPI Merchant Payout Report — RRN, gross amount, settlement date' },
];

@Component({
  selector: 'app-upload-ucr-feeds',
  standalone: true,
  imports: [
    UploadUcrIpComponent,
    UploadUcrOpComponent,
    UploadUcrDiagComponent,
    UploadCardMprComponent,
    UploadCardPinelabsComponent,
    UploadUpiMprComponent,
  ],
  templateUrl: './upload-ucr-feeds.component.html',
  styleUrl: './upload-ucr-feeds.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UploadUcrFeedsComponent {
  protected readonly tabs = TABS;
  protected readonly active = signal<UcrFeedTabId>(TABS[0].id);

  constructor() {
    const requested = inject(ActivatedRoute).snapshot.queryParamMap.get('tab');
    if (requested && TABS.some((t) => t.id === requested)) {
      this.active.set(requested as UcrFeedTabId);
    }
  }

  protected select(id: UcrFeedTabId): void {
    this.active.set(id);
  }
}
