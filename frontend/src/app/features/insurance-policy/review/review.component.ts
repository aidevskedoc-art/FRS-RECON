import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { DecimalPipe } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { PolicySummaryComponent } from '../shared/policy-summary/policy-summary.component';
import { MemberTableComponent } from '../shared/member-table/member-table.component';
import { ExtractionService } from '../../../core/services/extraction.service';
import { ValidationService } from '../../../core/services/validation.service';
import { PolicyService } from '../../../core/services/policy.service';

@Component({
  selector: 'app-review',
  standalone: true,
  imports: [RouterLink, DecimalPipe, ButtonModule, PolicySummaryComponent, MemberTableComponent],
  templateUrl: './review.component.html',
  styleUrl: './review.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReviewComponent {
  readonly id = input.required<string>();

  private readonly router = inject(Router);
  private readonly extractionService = inject(ExtractionService);
  private readonly validationService = inject(ValidationService);
  private readonly policyService = inject(PolicyService);

  protected readonly result = computed(() => this.extractionService.resultFor(this.id())());
  protected readonly validation = computed(() => this.validationService.validationFor(this.id())());
  protected readonly passedChecksCount = computed(
    () => this.validation().checks.filter((c) => c.passed).length,
  );
  protected readonly saving = signal(false);
  protected readonly saveError = signal<string | null>(null);

  constructor() {
    effect(() => {
      const documentId = this.id();
      if (!this.extractionService.resultFor(documentId)()) {
        this.extractionService.fetchResult(documentId).subscribe({ error: () => {} });
      }
      this.validationService.fetch(documentId).subscribe({ error: () => {} });
    });
  }

  protected save(thenGenerateExcel: boolean): void {
    const result = this.result();
    if (!result || this.validation().isSaveBlocked || this.saving()) return;

    this.saving.set(true);
    this.saveError.set(null);
    this.policyService.save(this.id()).subscribe({
      next: ({ policy }) => {
        this.saving.set(false);
        if (thenGenerateExcel) {
          this.router.navigate(['/insurance-policy/excel-preview'], { queryParams: { ids: policy.id } });
        } else {
          this.router.navigate(['/insurance-policy/documents', this.id(), 'success']);
        }
      },
      error: (err) => {
        this.saving.set(false);
        this.saveError.set(err?.message ?? 'Save failed');
      },
    });
  }
}
