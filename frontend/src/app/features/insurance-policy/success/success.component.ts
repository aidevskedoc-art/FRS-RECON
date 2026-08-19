import { ChangeDetectionStrategy, Component, computed, effect, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { PolicyService } from '../../../core/services/policy.service';
import { ExtractionService } from '../../../core/services/extraction.service';

@Component({
  selector: 'app-success',
  standalone: true,
  imports: [RouterLink, ButtonModule],
  templateUrl: './success.component.html',
  styleUrl: './success.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SuccessComponent {
  readonly id = input.required<string>();

  private readonly policyService = inject(PolicyService);
  private readonly extractionService = inject(ExtractionService);

  protected readonly policy = computed(() => this.policyService.policyByDocumentId(this.id()));
  protected readonly result = computed(() => this.extractionService.resultFor(this.id())());

  constructor() {
    effect(() => {
      const documentId = this.id();
      if (!this.policyService.policyByDocumentId(documentId)) {
        this.policyService.refresh().subscribe({ error: () => {} });
      }
      if (!this.extractionService.resultFor(documentId)()) {
        this.extractionService.fetchResult(documentId).subscribe({ error: () => {} });
      }
    });
  }

  protected readonly processingTimeMs = computed(() => {
    const info = this.policyService.lastSaveInfo();
    const p = this.policy();
    return info && p && info.policyId === p.id ? info.processingTimeMs : null;
  });
}
