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
