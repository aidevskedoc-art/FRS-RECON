import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { Router } from '@angular/router';
import { DomSanitizer } from '@angular/platform-browser';
import { ButtonModule } from 'primeng/button';
import { TooltipModule } from 'primeng/tooltip';
import { ConfidenceIndicatorComponent } from '../shared/confidence-indicator/confidence-indicator.component';
import { MemberTableComponent } from '../shared/member-table/member-table.component';
import { PolicyDocumentService, errorMessage } from '../../../core/services/policy-document.service';
import { ExtractionService } from '../../../core/services/extraction.service';
import { InsuredMember } from '../../../core/models';

type FieldType = 'text' | 'number' | 'date' | 'currency';

interface EditableField {
  path: string;
  label: string;
  type: FieldType;
  value: string | number;
}

@Component({
  selector: 'app-extraction',
  standalone: true,
  imports: [NgTemplateOutlet, ButtonModule, TooltipModule, ConfidenceIndicatorComponent, MemberTableComponent],
  templateUrl: './extraction.component.html',
  styleUrl: './extraction.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ExtractionComponent {
  readonly id = input.required<string>();
  readonly focusField = input<string>();

  private readonly router = inject(Router);
  private readonly sanitizer = inject(DomSanitizer);
  protected readonly policyDocuments = inject(PolicyDocumentService);
  protected readonly extractionService = inject(ExtractionService);

  protected readonly document = computed(() => this.policyDocuments.documentById(this.id()));
  protected readonly result = computed(() => this.extractionService.resultFor(this.id())());

  protected readonly fieldMeta = computed(() => {
    const map = new Map<string, { confidence: 'high' | 'medium' | 'low'; score: number; verified: boolean; sourcePage: number | null }>();
    for (const f of this.result()?.fields ?? []) {
      map.set(f.path, { confidence: f.confidence, score: f.confidenceScore, verified: f.verified, sourcePage: f.sourcePage });
    }
    return map;
  });

  protected readonly policyFields = computed<EditableField[]>(() => {
    const p = this.result()?.policy;
    if (!p) return [];
    return [
      { path: 'policyHolder.name', label: 'Policyholder', type: 'text', value: p.policyHolder.name },
      { path: 'insuranceCompany', label: 'Insurance Company', type: 'text', value: p.insuranceCompany },
      { path: 'policyNumber', label: 'Policy Number', type: 'text', value: p.policyNumber },
      { path: 'policyStartDate', label: 'Policy Start Date', type: 'date', value: p.policyStartDate },
      { path: 'policyEndDate', label: 'Policy End Date', type: 'date', value: p.policyEndDate },
      { path: 'policyTenureDays', label: 'Policy Tenure (days)', type: 'number', value: p.policyTenureDays },
      { path: 'policyReceiptDate', label: 'Policy Receipt Date', type: 'date', value: p.policyReceiptDate },
      { path: 'premium.sumInsured', label: 'Sum Insured', type: 'currency', value: p.premium.sumInsured },
      { path: 'policyType', label: 'Policy Type', type: 'text', value: p.policyType },
      { path: 'planChosen', label: 'Plan Chosen', type: 'text', value: p.planChosen },
      { path: 'newOrRenewal', label: 'New / Renewal Policy', type: 'text', value: p.newOrRenewal },
    ];
  });

  protected readonly premiumFields = computed<EditableField[]>(() => {
    const p = this.result()?.policy;
    if (!p) return [];
    return [
      { path: 'premium.totalBasicPremium', label: 'Total Basic Premium', type: 'currency', value: p.premium.totalBasicPremium },
      { path: 'premium.familyFloaterDiscount', label: 'Family Floater Discount', type: 'currency', value: p.premium.familyFloaterDiscount },
      { path: 'premium.premium', label: 'Premium', type: 'currency', value: p.premium.premium },
      { path: 'premium.gst', label: 'GST', type: 'currency', value: p.premium.gst },
      { path: 'premium.totalPremium', label: 'Total Premium', type: 'currency', value: p.premium.totalPremium },
      { path: 'receiptNumber', label: 'Receipt Number', type: 'text', value: p.receiptNumber },
    ];
  });

  protected readonly addressFields = computed<EditableField[]>(() => {
    const p = this.result()?.policy;
    if (!p) return [];
    return [
      { path: 'policyHolder.address', label: "Policyholder's Address", type: 'text', value: p.policyHolder.address },
      { path: 'insuranceCompanyAddress', label: 'Insurance Company Address', type: 'text', value: p.insuranceCompanyAddress },
      { path: 'policyHolder.customerId', label: 'Customer ID', type: 'text', value: p.policyHolder.customerId },
    ];
  });

  protected readonly currentPage = signal(1);

  protected readonly safePdfUrl = computed(() => {
    const url = this.document()?.fileUrl;
    if (!url) return null;
    return this.sanitizer.bypassSecurityTrustResourceUrl(`${url}#page=${this.currentPage()}&view=FitH`);
  });

  protected readonly locatedField = signal<string | null>(null);
  protected readonly highlightedPath = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly fillingMissing = signal(false);
  protected readonly loadError = signal<string | null>(null);

  /** How many currently-visible fields are blank — hides the AI button once nothing's left to fill. */
  protected readonly missingFieldCount = computed(
    () => [...this.fieldMeta().values()].filter((m) => m.confidence === 'low').length,
  );


  protected readonly aiReportOpen = signal(true);

  /**
   * Turns the backend's AI diagnostics into something readable. The point
   * is to answer "how much did the AI actually get?" without the reader
   * having to interpret a status code — so every non-'ran' outcome gets a
   * plain-English reason, and the stat row always reports what was *sent*
   * as well as what came back (a zero-character send explains a
   * zero-field result on its own).
   */
  protected readonly aiReport = computed(() => {
    const d = this.result()?.metadata?.aiDiagnostics ?? null;
    if (!d) return null;

    const REASONS: Record<string, string> = {
      NO_TEXT_LAYER: 'This PDF is a scan with no text layer, and the file itself was not available to read as images.',
      NOT_CONFIGURED: 'No GEMINI_API_KEY is set on the backend, so the AI pass never ran.',
      BAD_RESPONSE: 'The model replied with output that could not be parsed as JSON.',
      NOTHING_MISSING: 'The format parser filled every field on its own, so the AI was never asked.',
      API_ERROR: 'The AI request failed before it returned anything.',
      PDF_TOO_LARGE: 'This PDF is a scan, and it is too large to send for visual reading. Reduce its resolution or split it.',
    };

    const badge = { ran: 'Ran', skipped: 'Skipped', failed: 'Failed', not_needed: 'Not needed' }[d.status] ?? d.status;
    const tone = { ran: 'success', skipped: 'warning', failed: 'danger', not_needed: 'neutral' }[d.status] ?? 'neutral';

    let headline: string;
    if (d.status === 'ran') {
      const how = d.inputMode === 'pdf-vision'
        ? 'This PDF had no text layer, so its pages were read as images. '
        : '';
      headline = how + (d.mode === 'full'
        ? 'The whole policy was read by AI — no hand-written parser matched this insurer. It returned '
          + (d.policyFieldsReturned ?? 0) + ' of ' + (d.policyFieldsTotal ?? 0) + ' policy fields and '
          + (d.membersReturned ?? 0) + ' insured member(s).'
        : 'AI was asked to fill the gaps the parser left. It returned ' + (d.policyFieldsReturned ?? 0)
          + ' of ' + (d.policyFieldsTotal ?? 0) + ' policy fields, and ' + (d.filledCount ?? 0)
          + ' of those were actually written in (the rest were already filled).');
    } else {
      headline = d.message || REASONS[d.reason ?? ''] || 'The AI pass did not run.';
    }

    const stats: { label: string; value: string }[] = [
      { label: 'Model', value: d.model ?? 'not set' },
      { label: 'Read as', value: d.inputMode === 'pdf-vision' ? 'page images (OCR)' : 'text layer' },
      { label: 'Text sent to AI', value: d.textChars.toLocaleString() + ' chars' + (d.textChars === 0 && d.inputMode !== 'pdf-vision' ? '  (empty!)' : '') },
      { label: 'Pages', value: String(d.pagesSent) },
    ];
    if (d.status === 'ran') {
      stats.push(
        { label: 'Policy fields returned', value: (d.policyFieldsReturned ?? 0) + ' / ' + (d.policyFieldsTotal ?? 0) },
        { label: 'Members returned', value: String(d.membersReturned ?? 0) },
        { label: 'Fields written in', value: String(d.filledCount ?? 0) },
        { label: 'Round trip', value: d.elapsedMs != null ? (d.elapsedMs / 1000).toFixed(1) + 's' : '—' },
      );
    }

    return {
      badge,
      tone,
      headline,
      stats,
      filled: d.filledPaths ?? [],
      empty: d.emptyFields ?? [],
      ranAt: d.ranAt ?? null,
    };
  });

  constructor() {
    effect(() => {
      const documentId = this.id();
      if (!this.policyDocuments.documentById(documentId)) {
        this.policyDocuments.fetchById(documentId).subscribe({ error: () => {} });
      }
      if (!this.extractionService.resultFor(documentId)()) {
        this.extractionService.fetchResult(documentId).subscribe({
          error: (err) => this.loadError.set(errorMessage(err)),
        });
      }
    });

    effect(() => {
      const path = this.focusField();
      if (!path) return;
      this.highlightedPath.set(path);
      queueMicrotask(() => {
        const elementId = path.startsWith('members.') ? 'members-section' : path;
        document.getElementById(elementId)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      setTimeout(() => {
        if (this.highlightedPath() === path) this.highlightedPath.set(null);
      }, 2200);
    });
  }

  private track(op: ReturnType<ExtractionService['updateField']>): void {
    this.saving.set(true);
    op.subscribe({
      next: () => this.saving.set(false),
      error: (err) => {
        this.saving.set(false);
        this.loadError.set(errorMessage(err));
      },
    });
  }

  protected onFieldChange(event: Event, path: string, type: FieldType): void {
    const raw = (event.target as HTMLInputElement).value;
    const value = type === 'number' || type === 'currency' ? Number(raw) : raw;
    this.track(this.extractionService.updateField(this.id(), path, value));
  }

  protected locateField(field: EditableField): void {
    const meta = this.fieldMeta().get(field.path);
    if (meta?.sourcePage) {
      this.currentPage.set(meta.sourcePage);
      this.locatedField.set(field.label);
      setTimeout(() => {
        if (this.locatedField() === field.label) this.locatedField.set(null);
      }, 2500);
    }
  }

  protected addMember(member: Omit<InsuredMember, 'id'>): void {
    this.track(this.extractionService.addMember(this.id(), member));
  }

  protected updateMember(event: { id: string; patch: Partial<InsuredMember> }): void {
    this.track(this.extractionService.updateMember(this.id(), event.id, event.patch));
  }

  protected removeMember(memberId: string): void {
    this.track(this.extractionService.removeMember(this.id(), memberId));
  }

  protected duplicateMember(memberId: string): void {
    this.track(this.extractionService.duplicateMember(this.id(), memberId));
  }

  protected fillMissingWithAi(): void {
    this.fillingMissing.set(true);
    this.extractionService.fillMissingWithAi(this.id()).subscribe({
      next: () => this.fillingMissing.set(false),
      error: (err) => {
        this.fillingMissing.set(false);
        this.loadError.set(errorMessage(err));
      },
    });
  }

  protected goToValidation(): void {
    this.router.navigate(['/insurance-policy/documents', this.id(), 'validation']);
  }
}
