import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TooltipModule } from 'primeng/tooltip';
import { DiagOpPaymentService } from '../../../core/services/diag-op-payment.service';
import { errorMessage } from '../../../core/services/policy-document.service';

@Component({
  selector: 'app-view-diag-op-payments',
  standalone: true,
  imports: [RouterLink, DatePipe, ButtonModule, TableModule, TooltipModule],
  templateUrl: './view-diag-op-payments.component.html',
  styleUrl: './view-diag-op-payments.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ViewDiagOpPaymentsComponent {
  private readonly router = inject(Router);
  protected readonly diagOpPayments = inject(DiagOpPaymentService);

  protected readonly deletingId = signal<string | null>(null);
  protected readonly deleteError = signal<string | null>(null);

  constructor() {
    this.diagOpPayments.refreshBatches().subscribe({ error: () => {} });
  }

  protected view(batchId: string): void {
    this.router.navigate(['/upload-online/diag-op-payments', batchId]);
  }

  protected deleteBatch(batchId: string): void {
    if (this.deletingId()) return;
    this.deletingId.set(batchId);
    this.deleteError.set(null);
    this.diagOpPayments.deleteBatch(batchId).subscribe({
      next: () => this.deletingId.set(null),
      error: (err) => {
        this.deletingId.set(null);
        this.deleteError.set(errorMessage(err));
      },
    });
  }
}
