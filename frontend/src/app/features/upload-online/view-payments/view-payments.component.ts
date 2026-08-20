import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TooltipModule } from 'primeng/tooltip';
import { OnlineUploadService } from '../../../core/services/online-upload.service';
import { UploadType } from '../../../core/models';

type TypeFilter = 'ALL' | UploadType;

@Component({
  selector: 'app-view-payments',
  standalone: true,
  imports: [RouterLink, DatePipe, ButtonModule, TableModule, TooltipModule],
  templateUrl: './view-payments.component.html',
  styleUrl: './view-payments.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ViewPaymentsComponent {
  private readonly router = inject(Router);
  protected readonly onlineUpload = inject(OnlineUploadService);

  protected readonly typeFilter = signal<TypeFilter>('ALL');

  protected readonly batches = computed(() => {
    const filter = this.typeFilter();
    const all = this.onlineUpload.batches();
    return filter === 'ALL' ? all : all.filter((b) => b.uploadType === filter);
  });

  constructor() {
    this.load();
  }

  private load(): void {
    this.onlineUpload.refreshBatches().subscribe({ error: () => {} });
  }

  protected setFilter(filter: TypeFilter): void {
    this.typeFilter.set(filter);
  }

  protected view(batchId: string): void {
    this.router.navigate(['/upload-online/payments', batchId]);
  }

  protected deleteBatch(batchId: string): void {
    this.onlineUpload.deleteBatch(batchId).subscribe({ error: () => {} });
  }
}
