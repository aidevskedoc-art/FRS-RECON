import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { ProgressBarModule } from 'primeng/progressbar';
import { PolicyDocumentService, errorMessage } from '../../../core/services/policy-document.service';
import { ValidationService } from '../../../core/services/validation.service';

@Component({
  selector: 'app-validation',
  standalone: true,
  imports: [RouterLink, ButtonModule, ProgressBarModule],
  templateUrl: './validation.component.html',
  styleUrl: './validation.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ValidationComponent {
  readonly id = input.required<string>();

  private readonly router = inject(Router);
  private readonly validationService = inject(ValidationService);
  protected readonly policyDocuments = inject(PolicyDocumentService);

  protected readonly document = computed(() => this.policyDocuments.documentById(this.id()));
  protected readonly validation = computed(() => this.validationService.validationFor(this.id())());
  protected readonly loading = signal(true);
  protected readonly loadError = signal<string | null>(null);

  constructor() {
    effect(() => {
      const documentId = this.id();
      if (!this.policyDocuments.documentById(documentId)) {
        this.policyDocuments.fetchById(documentId).subscribe({ error: () => {} });
      }
      this.loading.set(true);
      this.validationService.fetch(documentId).subscribe({
        next: () => this.loading.set(false),
        error: (err) => {
          this.loading.set(false);
          this.loadError.set(errorMessage(err));
        },
      });
    });
  }

  protected readonly errorIssues = computed(() => this.validation().issues.filter((i) => i.severity === 'error'));
  protected readonly warningIssues = computed(() => this.validation().issues.filter((i) => i.severity === 'warning'));

  protected reviewIssue(fieldPath: string): void {
    this.router.navigate(['/insurance-policy/documents', this.id(), 'extraction'], {
      queryParams: { focusField: fieldPath },
    });
  }

  protected goToReview(): void {
    this.router.navigate(['/insurance-policy/documents', this.id(), 'review']);
  }
}
