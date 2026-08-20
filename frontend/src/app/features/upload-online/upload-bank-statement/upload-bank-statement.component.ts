import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { BankStatementService } from '../../../core/services/bank-statement.service';
import { AuthService } from '../../../core/services/auth.service';
import { errorMessage } from '../../../core/services/policy-document.service';
import { BankStatementUpload } from '../../../core/models';

@Component({
  selector: 'app-upload-bank-statement',
  standalone: true,
  imports: [ButtonModule],
  templateUrl: './upload-bank-statement.component.html',
  styleUrl: './upload-bank-statement.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UploadBankStatementComponent {
  private readonly router = inject(Router);
  private readonly bankStatements = inject(BankStatementService);
  private readonly auth = inject(AuthService);

  protected readonly isDragging = signal(false);
  protected readonly pendingFile = signal<File | null>(null);
  protected readonly rejected = signal(false);
  protected readonly uploading = signal(false);
  protected readonly uploadError = signal<string | null>(null);
  protected readonly uploadedBatch = signal<BankStatementUpload | null>(null);

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
    this.addFile(event.dataTransfer?.files ?? null);
  }

  protected onFileInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.addFile(input.files);
    input.value = '';
  }

  private addFile(fileList: FileList | null): void {
    if (!fileList || fileList.length === 0) return;
    const file = fileList[0];
    const isSpreadsheet = /\.(xlsx|xls)$/i.test(file.name);
    this.rejected.set(!isSpreadsheet);
    if (isSpreadsheet) {
      this.pendingFile.set(file);
      this.uploadError.set(null);
      this.uploadedBatch.set(null);
    }
  }

  protected clearPending(): void {
    this.pendingFile.set(null);
    this.rejected.set(false);
  }

  protected upload(): void {
    const file = this.pendingFile();
    if (!file || this.uploading()) return;
    this.uploading.set(true);
    this.uploadError.set(null);

    this.bankStatements.upload(file, this.auth.userId()).subscribe({
      next: (batch) => {
        this.uploadedBatch.set(batch);
        this.pendingFile.set(null);
        this.uploading.set(false);
      },
      error: (err) => {
        this.uploadError.set(errorMessage(err));
        this.uploading.set(false);
      },
    });
  }

  protected viewBatches(): void {
    this.router.navigate(['/upload-online/bank-statements']);
  }

  protected fileSizeLabel(bytes: number): string {
    return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}
