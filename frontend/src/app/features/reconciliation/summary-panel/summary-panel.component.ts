import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { ReconciliationSummary } from '../../../core/models';

interface SummaryCard {
  label: string;
  value: string;
  icon: string;
  accent: 'blue' | 'success' | 'warning' | 'danger' | 'purple' | 'cyan';
  /** Amount cards read as money; count cards read as plain numbers. */
  wide?: boolean;
}

/**
 * The reconciliation dashboard — headline figures plus the per-payment-type
 * breakdown.
 *
 * Lives as its own component because two screens show it: the consolidated
 * Upload & Run screen displays it after a run, and the existing Reconciliation
 * Summary screen shows it standing alone. Sharing the component rather than
 * copying the markup means the two can never drift apart.
 *
 * One thing worth knowing when reading these numbers: the figures are a hybrid.
 * IP / Diag / UPI / Cheque are recomputed live on every request, so they are
 * correct whether or not anyone has pressed Generate. Card, UPI-gateway and the
 * bank/gateway sections read stored verdicts and stay empty until the matching
 * Generate has run — which is what the "not yet generated" notes elsewhere on
 * the summary screen are about.
 */
@Component({
  selector: 'app-summary-panel',
  standalone: true,
  imports: [],
  templateUrl: './summary-panel.component.html',
  styleUrl: './summary-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SummaryPanelComponent {
  readonly summary = input.required<ReconciliationSummary>();

  protected readonly cards = computed<SummaryCard[]>(() => {
    const s = this.summary();
    const c = s.combined;
    return [
      { label: 'Total Transactions', value: count(c.totalTransactions), icon: 'pi pi-list', accent: 'blue' },
      { label: 'Total Amount', value: money(c.totalAmount), icon: 'pi pi-indian-rupee', accent: 'blue', wide: true },
      { label: 'Matched', value: count(c.totalMatched), icon: 'pi pi-check-circle', accent: 'success' },
      { label: 'Gateway Matched', value: count(c.totalEasebuzzMatched), icon: 'pi pi-bolt', accent: 'purple' },
      { label: 'Contra Entries', value: count(c.totalContra), icon: 'pi pi-replay', accent: 'cyan' },
      { label: 'Partially Matched', value: count(c.totalPartialMatch), icon: 'pi pi-check', accent: 'blue' },
      { label: 'Amount Mismatched', value: count(c.totalMismatched), icon: 'pi pi-exclamation-triangle', accent: 'warning' },
      { label: 'Unmatched', value: count(c.totalUnmatched), icon: 'pi pi-times-circle', accent: 'danger' },
      { label: 'Balance Amount', value: money(c.balanceAmount), icon: 'pi pi-wallet', accent: 'warning', wide: true },
      { label: 'Exceptions', value: count(c.totalAmbiguous + c.totalExcluded), icon: 'pi pi-flag', accent: 'purple' },
    ];
  });

  /** The per-payment-type rows, built once so the template stays declarative. */
  protected readonly rows = computed(() => {
    const s = this.summary();
    return [
      { name: 'IP Payments', d: s.ipPayments },
      { name: 'Diagnostics / OP Payments', d: s.diagPayments },
      { name: 'UPI Payments', d: s.upiPayments },
      { name: 'Cheque Collections', d: s.chequePayments },
      { name: 'Card (gateway-verified)', d: s.cardPayments },
      { name: 'UPI (gateway-verified)', d: s.upiGatewayPayments },
    ];
  });

  protected money(value: number | null | undefined): string {
    return money(value);
  }

  protected count(value: number | null | undefined): string {
    return count(value);
  }
}

function money(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function count(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return Number(value).toLocaleString('en-IN');
}
