import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TooltipModule } from 'primeng/tooltip';
import { DiagOpPaymentService } from '../../../core/services/diag-op-payment.service';

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

  constructor() {
    this.diagOpPayments.refreshBatches().subscribe({ error: () => {} });
  }

  protected view(batchId: string): void {
    this.router.navigate(['/upload-online/diag-op-payments', batchId]);
  }

  protected deleteBatch(batchId: string): void {
    this.diagOpPayments.deleteBatch(batchId).subscribe({ error: () => {} });
  }
}
