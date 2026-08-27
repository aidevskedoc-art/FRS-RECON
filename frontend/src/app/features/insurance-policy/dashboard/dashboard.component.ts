import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { DocumentCardComponent } from '../shared/document-card/document-card.component';
import { PolicyDocumentService } from '../../../core/services/policy-document.service';
import { PolicyService } from '../../../core/services/policy.service';
import { PolicyDocument } from '../../../core/models';
import { AnimatedCounterComponent } from '../../../shared/ui/animated-counter.component';
import { CircularProgressComponent } from '../../../shared/ui/circular-progress.component';
import { MagneticDirective } from '../../../shared/motion/magnetic.directive';

interface KpiCard {
  label: string;
  value: number;
  icon: string;
  /** Section accent key — drives the icon chip's colour. */
  accent: 'insurance' | 'rules' | 'reports' | 'admin' | 'masters' | 'online';
  /** Optional share-of-total ring, 0–100. Omitted when a ratio is meaningless. */
  ring?: number;
  caption?: string;
  format?: 'number' | 'compact';
}

/** The document lifecycle, in the order the app actually moves through it. */
const PIPELINE = [
  { label: 'Upload', icon: 'pi pi-cloud-upload' },
  { label: 'Extract', icon: 'pi pi-sparkles' },
  { label: 'Validate', icon: 'pi pi-check-circle' },
  { label: 'Review', icon: 'pi pi-eye' },
  { label: 'Excel', icon: 'pi pi-file-excel' },
];

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [
    RouterLink,
    DocumentCardComponent,
    AnimatedCounterComponent,
    CircularProgressComponent,
    MagneticDirective,
  ],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DashboardComponent {
  private readonly router = inject(Router);
  protected readonly policyDocuments = inject(PolicyDocumentService);
  protected readonly policyService = inject(PolicyService);

  protected readonly pipeline = PIPELINE;

  constructor() {
    this.policyDocuments.refresh().subscribe({ error: () => {} });
    this.policyService.refresh().subscribe({ error: () => {} });
  }

  protected readonly kpiCards = computed<KpiCard[]>(() => {
    const counts = this.policyDocuments.counts();
    const total = counts.total || 0;
    // Guard the divisor: a fresh install has no documents, and 0/0 would
    // render "NaN%" inside the ring.
    const share = (n: number) => (total > 0 ? (n / total) * 100 : 0);

    return [
      {
        label: 'Total Documents',
        value: total,
        icon: 'pi pi-file',
        accent: 'insurance',
        caption: 'All time',
      },
      {
        label: 'Processed',
        value: counts.completed,
        icon: 'pi pi-check-circle',
        accent: 'rules',
        ring: share(counts.completed),
        caption: `${Math.round(share(counts.completed))}% of intake`,
      },
      {
        label: 'Needs Review',
        value: counts.needsReview,
        icon: 'pi pi-exclamation-triangle',
        accent: 'reports',
        ring: share(counts.needsReview),
        caption: 'Awaiting a human',
      },
      {
        label: 'Failed',
        value: counts.failed,
        icon: 'pi pi-times-circle',
        accent: 'admin',
        ring: share(counts.failed),
        caption: 'Retry available',
      },
      {
        label: 'Total Policies',
        value: this.policyService.policies().length,
        icon: 'pi pi-shield',
        accent: 'masters',
        caption: 'Extracted records',
      },
      {
        label: 'Insured Members',
        value: this.policyService.totalInsuredMembers(),
        icon: 'pi pi-users',
        accent: 'online',
        format: 'compact',
        caption: 'Across all policies',
      },
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
