import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TooltipModule } from 'primeng/tooltip';
import { BankStatementService } from '../../../core/services/bank-statement.service';
import { errorMessage } from '../../../core/services/policy-document.service';

@Component({
  selector: 'app-view-bank-statements',
  standalone: true,
  imports: [RouterLink, DatePipe, ButtonModule, TableModule, TooltipModule],
  templateUrl: './view-bank-statements.component.html',
  styleUrl: './view-bank-statements.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ViewBankStatementsComponent {
  private readonly router = inject(Router);
  protected readonly bankStatements = inject(BankStatementService);

  protected readonly expandedIds = signal<ReadonlySet<string>>(new Set());
  protected readonly error = signal<string | null>(null);

  constructor() {
    this.bankStatements.refreshBatches().subscribe({ error: (err) => this.error.set(errorMessage(err)) });
  }

  protected toggle(batchId: string): void {
    const expanded = new Set(this.expandedIds());
    if (expanded.has(batchId)) {
      expanded.delete(batchId);
    } else {
      expanded.add(batchId);
    }
    this.expandedIds.set(expanded);
  }

  protected isExpanded(batchId: string): boolean {
    return this.expandedIds().has(batchId);
  }

  protected viewRecords(batchId: string): void {
    this.router.navigate(['/upload-online/bank-statements', batchId]);
  }

  protected deleteBatch(batchId: string): void {
    this.error.set(null);
    this.bankStatements.deleteBatch(batchId).subscribe({ error: (err) => this.error.set(errorMessage(err)) });
  }
}
