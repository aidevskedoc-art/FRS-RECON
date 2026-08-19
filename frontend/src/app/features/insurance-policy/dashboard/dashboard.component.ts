import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { DocumentCardComponent } from '../shared/document-card/document-card.component';
import { PolicyDocumentService } from '../../../core/services/policy-document.service';
import { PolicyService } from '../../../core/services/policy.service';
import { PolicyDocument } from '../../../core/models';

interface SummaryCard {
  label: string;
  value: number;
  icon: string;
  accent: 'blue' | 'success' | 'warning' | 'danger' | 'purple' | 'cyan';
}

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [RouterLink, ButtonModule, DocumentCardComponent],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DashboardComponent {
  private readonly router = inject(Router);
  protected readonly policyDocuments = inject(PolicyDocumentService);
  protected readonly policyService = inject(PolicyService);

  constructor() {
    this.policyDocuments.refresh().subscribe({ error: () => {} });
    this.policyService.refresh().subscribe({ error: () => {} });
  }

  protected readonly summaryCards = computed<SummaryCard[]>(() => {
    const counts = this.policyDocuments.counts();
    return [
      { label: 'Total Documents', value: counts.total, icon: 'pi pi-file', accent: 'blue' },
      { label: 'Processed', value: counts.completed, icon: 'pi pi-check-circle', accent: 'success' },
      { label: 'Needs Review', value: counts.needsReview, icon: 'pi pi-exclamation-triangle', accent: 'warning' },
      { label: 'Failed', value: counts.failed, icon: 'pi pi-times-circle', accent: 'danger' },
      { label: 'Total Policies', value: this.policyService.policies().length, icon: 'pi pi-shield', accent: 'purple' },
      { label: 'Total Insured Members', value: this.policyService.totalInsuredMembers(), icon: 'pi pi-users', accent: 'cyan' },
    ];
  });

  protected readonly recentDocuments = computed(() => this.policyDocuments.documents().slice(0, 6));

  protected openDocument(document: PolicyDocument): void {
    if (['Uploaded', 'Scanning', 'Extracting', 'Validating'].includes(document.status)) {
      this.router.navigate(['/insurance-policy/documents', document.id, 'processing']);
    } else if (document.status === 'Completed' || document.status === 'Needs Review') {
      this.router.navigate(['/insurance-policy/documents', document.id, 'extraction']);
    }
  }

  protected retryDocument(document: PolicyDocument): void {
    this.policyDocuments.retry(document.id).subscribe({
      next: () => this.router.navigate(['/insurance-policy/documents', document.id, 'processing']),
      error: () => {},
    });
  }

  protected removeDocument(document: PolicyDocument): void {
    this.policyDocuments.remove(document.id).subscribe({
      next: () => this.policyService.refresh().subscribe({ error: () => {} }),
      error: () => {},
    });
  }
}
