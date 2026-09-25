import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { PaymentTypeSummary, ReconciliationSummary } from '../../../core/models';

interface SummaryCard {
  label: string;
  value: string;
  icon: string;
  accent: 'blue' | 'success' | 'warning' | 'danger' | 'purple' | 'cyan' | 'orange';
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
      { label: 'Total Amount', value: money(c.totalAmount), icon: 'pi pi-indian-rupee', accent: 'orange', wide: true },
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
    // Each type keeps one colour (the row's dot) — category colours, not status.
    return [
      { name: 'IP Payments', d: s.ipPayments, color: 'var(--ai-purple)' },
      { name: 'Diagnostics / OP Payments', d: s.diagPayments, color: 'var(--ai-orange)' },
      { name: 'UPI Payments', d: s.upiPayments, color: 'var(--ai-cyan)' },
      { name: 'Cheque Collections', d: s.chequePayments, color: '#db2777' },
      { name: 'Card (gateway-verified)', d: s.cardPayments, color: '#2563eb' },
      { name: 'UPI (gateway-verified)', d: s.upiGatewayPayments, color: '#0d9488' },
    ];
  });

  /** Share of receipts accounted for — matched, gateway-matched or contra — as a whole percent. */
  protected rate(d: PaymentTypeSummary): number {
    return reconciledRate(d.matched + d.easebuzzMatched + d.contra, d.total);
  }

  protected readonly combinedRate = computed(() => {
    const c = this.summary().combined;
    return reconciledRate(c.totalMatched + c.totalEasebuzzMatched + c.totalContra, c.totalTransactions);
  });

  /** Meter colour: green 95%+, amber 80–95%, red below. */
  protected tone(pct: number): 'good' | 'warn' | 'bad' {
    return pct >= 95 ? 'good' : pct >= 80 ? 'warn' : 'bad';
  }

  protected money(value: number | null | undefined): string {
    return money(value);
  }

  protected count(value: number | null | undefined): string {
    return count(value);
  }
}

function reconciledRate(done: number, total: number): number {
  if (!total) return 0;
  return Math.min(100, Math.floor((done / total) * 100)); // floor: 99.6% is not "100%"
}

function money(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function count(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return Number(value).toLocaleString('en-IN');
}
