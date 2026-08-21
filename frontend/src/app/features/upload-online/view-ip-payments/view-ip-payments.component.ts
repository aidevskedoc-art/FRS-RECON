import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TooltipModule } from 'primeng/tooltip';
import { IpPaymentService } from '../../../core/services/ip-payment.service';

@Component({
  selector: 'app-view-ip-payments',
  standalone: true,
  imports: [RouterLink, DatePipe, ButtonModule, TableModule, TooltipModule],
  templateUrl: './view-ip-payments.component.html',
  styleUrl: './view-ip-payments.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ViewIpPaymentsComponent {
  private readonly router = inject(Router);
  protected readonly ipPayments = inject(IpPaymentService);

  constructor() {
    this.ipPayments.refreshBatches().subscribe({ error: () => {} });
  }

  protected view(batchId: string): void {
    this.router.navigate(['/upload-online/ip-payments', batchId]);
  }

  protected deleteBatch(batchId: string): void {
    this.ipPayments.deleteBatch(batchId).subscribe({ error: () => {} });
  }
}
