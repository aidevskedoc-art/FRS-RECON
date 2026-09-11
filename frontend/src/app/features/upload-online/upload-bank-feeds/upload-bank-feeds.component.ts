import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { UploadBankStatementComponent } from '../upload-bank-statement/upload-bank-statement.component';
import { UploadPayuMprComponent } from '../upload-payu-mpr/upload-payu-mpr.component';
import { UploadEasebuzzComponent } from '../upload-easebuzz/upload-easebuzz.component';

type BankFeedTabId = 'bank' | 'payu' | 'easebuzz';

interface BankFeedTab {
  readonly id: BankFeedTabId;
  readonly label: string;
  readonly hint: string;
}

/**
 * One upload screen for every bank-side feed — the bank statement, the PayU
 * MPR and the EaseBuzz report — replacing three separate menu entries. The
 * individual screens are reused verbatim, mounted with `[embedded]="true"` so
 * only this hub renders the page header.
 */
const TABS: readonly BankFeedTab[] = [
  { id: 'bank', label: 'Bank Statement', hint: 'HDFC-style statement export — account and transaction table read automatically' },
  { id: 'payu', label: 'PayU MPR', hint: 'PayU Merchant Payment Report — the gateway-UPI settlement counterpart' },
  { id: 'easebuzz', label: 'EaseBuzz', hint: 'EaseBuzz gateway transaction report — one workbook, a sheet per unit' },
];

@Component({
  selector: 'app-upload-bank-feeds',
  standalone: true,
  imports: [UploadBankStatementComponent, UploadPayuMprComponent, UploadEasebuzzComponent],
  templateUrl: './upload-bank-feeds.component.html',
  styleUrl: './upload-bank-feeds.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UploadBankFeedsComponent {
  protected readonly tabs = TABS;
  protected readonly active = signal<BankFeedTabId>(TABS[0].id);

  constructor() {
    // A `?tab=` hint (from a "Upload" button on a list screen) opens the hub on
    // the right feed; anything unrecognised falls back to the first tab.
    const requested = inject(ActivatedRoute).snapshot.queryParamMap.get('tab');
    if (requested && TABS.some((t) => t.id === requested)) {
      this.active.set(requested as BankFeedTabId);
    }
  }

  protected select(id: BankFeedTabId): void {
    this.active.set(id);
  }
}
