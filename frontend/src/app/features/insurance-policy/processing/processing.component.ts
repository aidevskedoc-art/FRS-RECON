import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { ProcessingTimelineComponent } from '../shared/processing-timeline/processing-timeline.component';
import { PolicyDocumentService, errorMessage } from '../../../core/services/policy-document.service';
import { ExtractionService } from '../../../core/services/extraction.service';
import { PROCESSING_STEP_META } from '../../../core/models';

const ACTIVE_STATUSES = new Set(['Uploaded', 'Scanning', 'Extracting', 'Validating']);

@Component({
  selector: 'app-processing',
  standalone: true,
  imports: [RouterLink, ButtonModule, ProcessingTimelineComponent],
  templateUrl: './processing.component.html',
  styleUrl: './processing.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProcessingComponent {
  readonly id = input<string>();
  readonly ids = input<string>();

  private readonly router = inject(Router);
  protected readonly policyDocuments = inject(PolicyDocumentService);
  protected readonly extractionService = inject(ExtractionService);

  private readonly triggered = new Set<string>();
  protected readonly loadError = signal<string | null>(null);

  protected readonly documentIds = computed(() => {
    const single = this.id();
    if (single) return [single];
    const list = this.ids();
    return list ? list.split(',').filter(Boolean) : [];
  });

  protected readonly items = computed(() => {
    const docs = this.policyDocuments.documents();
    return this.documentIds()
      .map((id) => docs.find((d) => d.id === id))
      .filter((d): d is NonNullable<typeof d> => !!d)
      .map((doc) => ({
        doc,
        step: this.extractionService.stepFor(doc.id)(),
      }));
  });

  protected readonly isBatch = computed(() => this.documentIds().length > 1);

  protected readonly allReady = computed(() =>
    this.items().every((item) => item.step === 'ReadyForReview' || item.doc.status === 'Failed'),
  );

  protected readonly stepOrder = (step: string) =>
    PROCESSING_STEP_META[step as keyof typeof PROCESSING_STEP_META]?.order ?? 0;

  constructor() {
    effect(() => {
      for (const id of this.documentIds()) {
        if (this.triggered.has(id)) continue;
        this.triggered.add(id);

        const cached = this.policyDocuments.documentById(id);
        if (cached) {
          this.beginIfPending(id, cached.status);
        } else {
          // Deep-linked or hard-refreshed — the document cache is cold.
          this.policyDocuments.fetchById(id).subscribe({
            next: (doc) => this.beginIfPending(id, doc.status),
            error: (err) => this.loadError.set(errorMessage(err)),
          });
        }
      }
    });
  }

  private beginIfPending(id: string, status: string): void {
    if (ACTIVE_STATUSES.has(status)) {
      this.extractionService.startExtraction(id).subscribe({
        error: (err) => this.loadError.set(err?.message ?? 'Extraction failed'),
      });
    } else {
      // Already extracted — jump the timeline to its finished state.
      this.extractionService.fetchResult(id).subscribe({ error: () => {} });
    }
  }

  /** Shown only for the specific "no parser for this insurer" failure — not for other errors (e.g. a corrupted file). */
  protected isUnknownFormat(message: string | null | undefined): boolean {
    return !!message && /Unrecognised policy layout/i.test(message);
  }

  /** Retries a failed document through the AI fallback instead of the normal parser. */
  protected retryWithAi(documentId: string): void {
    this.extractionService.startAiExtraction(documentId).subscribe({
      error: (err) => this.loadError.set(err?.message ?? 'AI extraction failed'),
    });
  }

  protected goToExtraction(documentId: string): void {
    this.router.navigate(['/insurance-policy/documents', documentId, 'extraction']);
  }
}
