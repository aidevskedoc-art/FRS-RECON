import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TooltipModule } from 'primeng/tooltip';
import { BankStatementService } from '../../../core/services/bank-statement.service';
import { errorMessage } from '../../../core/services/policy-document.service';

@Component({
  selector: 'app-view-easebuzz',
  standalone: true,
  imports: [DatePipe, ButtonModule, TableModule, TooltipModule],
  templateUrl: './view-easebuzz.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ViewEasebuzzComponent {
  private readonly router = inject(Router);
  protected readonly bankStatements = inject(BankStatementService);

  protected readonly error = signal<string | null>(null);
  protected readonly deletingId = signal<string | null>(null);

  constructor() {
    this.bankStatements.refreshEasebuzzBatches().subscribe({ error: (err) => this.error.set(errorMessage(err)) });
  }

  protected viewRecords(batchId: string): void {
    this.router.navigate(['/upload-online/bank-statements', batchId]);
  }

  protected deleteBatch(batchId: string): void {
    if (this.deletingId()) return;
    this.deletingId.set(batchId);
    this.bankStatements.deleteEasebuzzBatch(batchId).subscribe({
      next: () => this.deletingId.set(null),
      error: (err) => {
        this.deletingId.set(null);
        this.error.set(errorMessage(err));
      },
    });
  }
}
