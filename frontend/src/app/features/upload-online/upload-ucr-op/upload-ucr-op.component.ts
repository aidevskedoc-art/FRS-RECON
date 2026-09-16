import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { catchError, concatMap, from, map, of } from 'rxjs';
import { Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { UcrUploadService } from '../../../core/services/ucr-upload.service';
import { AuthService } from '../../../core/services/auth.service';
import { errorMessage } from '../../../core/services/policy-document.service';
import { UcrBatch } from '../../../core/models';

@Component({
  selector: 'app-upload-ucr-op',
  standalone: true,
  imports: [ButtonModule],
  templateUrl: './upload-ucr-op.component.html',
  styleUrl: './upload-ucr-op.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UploadUcrOpComponent {
  private readonly router = inject(Router);
  private readonly ucrUpload = inject(UcrUploadService);
  private readonly auth = inject(AuthService);

  readonly embedded = input(false);

  protected readonly isDragging = signal(false);
  protected readonly pendingFiles = signal<File[]>([]);
  protected readonly rejected = signal(false);
  protected readonly uploading = signal(false);
  protected readonly uploadError = signal<string | null>(null);
  protected readonly uploadedBatches = signal<UcrBatch[]>([]);
  protected readonly uploadErrors = signal<{ fileName: string; message: string }[]>([]);
  protected readonly progress = signal<{ done: number; total: number } | null>(null);

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
    if (!fileList || fileList.length === 0) return;
    const incoming = Array.from(fileList);
    const valid = incoming.filter((f) => /\.(xlsx|xls)$/i.test(f.name));
    this.rejected.set(valid.length < incoming.length);
    if (valid.length) {
      this.pendingFiles.update((files) => [...files, ...valid]);
      this.uploadError.set(null);
    }
  }

  protected removeFile(index: number): void {
    this.pendingFiles.update((files) => files.filter((_, i) => i !== index));
  }

  protected upload(): void {
    const files = this.pendingFiles();
    if (!files.length || this.uploading()) return;
    this.uploading.set(true);
    this.uploadError.set(null);
    this.uploadedBatches.set([]);
    this.uploadErrors.set([]);
    this.progress.set({ done: 0, total: files.length });

    from(files)
      .pipe(
        concatMap((file) =>
          this.ucrUpload.uploadUcrOp(file, this.auth.userId()).pipe(
            map((batch) => ({ fileName: file.name, batch, error: null as string | null })),
            catchError((err) => of({ fileName: file.name, batch: null as UcrBatch | null, error: errorMessage(err) })),
          ),
        ),
      )
      .subscribe({
        next: (result) => {
          if (result.batch) this.uploadedBatches.update((b) => [...b, result.batch!]);
          else this.uploadErrors.update((e) => [...e, { fileName: result.fileName, message: result.error! }]);
          this.progress.update((p) => (p ? { ...p, done: p.done + 1 } : p));
        },
        complete: () => {
          this.pendingFiles.set([]);
          this.uploading.set(false);
          this.progress.set(null);
        },
      });
  }

  protected viewCardRecon(): void {
    this.router.navigate(['/matched-rules/card-reconciliation']);
  }

  protected fileSizeLabel(bytes: number): string {
    return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}
