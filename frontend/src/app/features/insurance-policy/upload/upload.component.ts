import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { DocumentCardComponent } from '../shared/document-card/document-card.component';
import { PageHeaderComponent } from '../../../shared/ui/page-header.component';
import { CircularProgressComponent } from '../../../shared/ui/circular-progress.component';
import { MagneticDirective } from '../../../shared/motion/magnetic.directive';
import {
  MAX_FILES_PER_REQUEST,
  PolicyDocumentService,
  UploadDuplicate,
  UploadFailure,
  errorMessage,
} from '../../../core/services/policy-document.service';
import { PolicyDocument } from '../../../core/models';

@Component({
  selector: 'app-upload',
  standalone: true,
  imports: [DocumentCardComponent, PageHeaderComponent, CircularProgressComponent, MagneticDirective],
  templateUrl: './upload.component.html',
  styleUrl: './upload.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UploadComponent {
  private readonly router = inject(Router);
  protected readonly policyDocuments = inject(PolicyDocumentService);

  protected readonly pendingFiles = signal<File[]>([]);
  protected readonly isDragging = signal(false);
  protected readonly rejectedCount = signal(0);
  protected readonly justUploadedIds = signal<string[]>([]);
  protected readonly uploading = signal(false);
  protected readonly uploadError = signal<string | null>(null);
  protected readonly duplicates = signal<UploadDuplicate[]>([]);
  protected readonly failed = signal<UploadFailure[]>([]);

  protected readonly uploadProgress = this.policyDocuments.uploadProgress;

  protected readonly pendingSizeLabel = computed(() => {
    const total = this.pendingFiles().reduce((sum, f) => sum + f.size, 0);
    return total < 1024 * 1024 ? `${(total / 1024).toFixed(0)} KB` : `${(total / (1024 * 1024)).toFixed(1)} MB`;
  });

  /** Files are sent in batches of this size — shown up front so a large selection isn't a surprise. */
  protected readonly batchCount = computed(() => Math.ceil(this.pendingFiles().length / MAX_FILES_PER_REQUEST));

  /** Whole-batch completion, for the dropzone's progress ring. */
  protected readonly uploadPercent = computed(() => {
    const progress = this.uploadProgress();
    if (!progress || progress.filesTotal === 0) {
      return 0;
    }
    return (progress.filesDone / progress.filesTotal) * 100;
  });

  /** Wall-clock duration of the last upload, reported on completion. */
  protected readonly lastDurationLabel = signal<string | null>(null);
  private uploadStartedAt = 0;

  protected readonly justUploaded = computed(() => {
    const ids = new Set(this.justUploadedIds());
    return this.policyDocuments.documents().filter((d) => ids.has(d.id));
  });

  protected onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.isDragging.set(true);
  }

  protected onDragLeave(): void {
    this.isDragging.set(false);
  }

  protected onDrop(event: DragEvent): void {
    event.preventDefault();
    this.isDragging.set(false);
    this.addFiles(event.dataTransfer?.files ?? null);
  }

  protected onFileInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.addFiles(input.files);
    input.value = '';
  }

  private addFiles(fileList: FileList | null): void {
    if (!fileList) return;
    const files = Array.from(fileList);
    const pdfs = files.filter((f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
    this.rejectedCount.set(files.length - pdfs.length);
    this.pendingFiles.update((existing) => [...existing, ...pdfs]);
  }

  protected removePending(file: File): void {
    this.pendingFiles.update((files) => files.filter((f) => f !== file));
  }

  protected clearPending(): void {
    this.pendingFiles.set([]);
    this.rejectedCount.set(0);
    this.duplicates.set([]);
  }

  protected upload(): void {
    if (this.pendingFiles().length === 0 || this.uploading()) return;
    this.uploading.set(true);
    this.uploadError.set(null);
    this.duplicates.set([]);
    this.failed.set([]);
    this.lastDurationLabel.set(null);
    this.uploadStartedAt = performance.now();

    this.policyDocuments.upload(this.pendingFiles()).subscribe({
      next: ({ documents, duplicates, failed }) => {
        this.justUploadedIds.update((ids) => [...documents.map((d) => d.id), ...ids]);
        this.duplicates.set(duplicates);
        this.failed.set(failed);
        // Only files that actually landed leave the pending list. A skipped
        // duplicate stays so it's obvious which one it was, and a failed
        // file stays so "Upload" retries just those.
        const keep = new Set([
          ...duplicates.map((d) => d.fileName),
          ...failed.map((f) => f.fileName),
        ]);
        this.pendingFiles.set(this.pendingFiles().filter((f) => keep.has(f.name)));
        this.lastDurationLabel.set(`${((performance.now() - this.uploadStartedAt) / 1000).toFixed(1)}s`);
        this.uploading.set(false);
      },
      error: (err) => {
        this.uploadError.set(errorMessage(err));
        this.uploading.set(false);
      },
    });
  }

  protected viewExisting(duplicate: UploadDuplicate): void {
    this.router.navigate(['/insurance-policy/documents', duplicate.existingDocumentId, 'processing']);
  }

  protected openDocument(document: PolicyDocument): void {
    this.router.navigate(['/insurance-policy/documents', document.id, 'processing']);
  }

  protected removeDocument(document: PolicyDocument): void {
    this.policyDocuments.remove(document.id).subscribe({
      next: () => this.justUploadedIds.update((ids) => ids.filter((id) => id !== document.id)),
      error: (err) => this.uploadError.set(errorMessage(err)),
    });
  }

  protected processAll(): void {
    const ids = this.justUploaded()
      .filter((d) => d.status === 'Uploaded')
      .map((d) => d.id);
    if (ids.length === 0) return;
    this.router.navigate(['/insurance-policy/processing'], { queryParams: { ids: ids.join(',') } });
  }
}
