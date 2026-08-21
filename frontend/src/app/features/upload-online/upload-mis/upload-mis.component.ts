import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { IpPaymentService } from '../../../core/services/ip-payment.service';
import { DiagOpPaymentService } from '../../../core/services/diag-op-payment.service';
import { AuthService } from '../../../core/services/auth.service';
import { errorMessage } from '../../../core/services/policy-document.service';
import { OnlineUploadBatch } from '../../../core/models';

type MisFormatChoice = '1' | '2';

@Component({
  selector: 'app-upload-mis',
  standalone: true,
  imports: [ButtonModule],
  templateUrl: './upload-mis.component.html',
  styleUrl: './upload-mis.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UploadMisComponent {
  private readonly router = inject(Router);
  private readonly ipPayments = inject(IpPaymentService);
  private readonly diagOpPayments = inject(DiagOpPaymentService);
  private readonly auth = inject(AuthService);

  protected readonly format = signal<MisFormatChoice>('1');
  protected readonly isDragging = signal(false);
  protected readonly pendingFile = signal<File | null>(null);
  protected readonly rejected = signal(false);
  protected readonly uploading = signal(false);
  protected readonly uploadError = signal<string | null>(null);
  protected readonly uploadedBatch = signal<OnlineUploadBatch | null>(null);

  protected selectFormat(value: MisFormatChoice): void {
    this.format.set(value);
    this.clearPending();
  }

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

    const upload$ =
      this.format() === '1'
        ? this.ipPayments.upload(file, this.auth.userId())
        : this.diagOpPayments.upload(file, this.auth.userId());

    upload$.subscribe({
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

  protected viewBatch(): void {
    const batch = this.uploadedBatch();
    if (!batch) return;
    const base = batch.uploadType === 'IP_PAYMENT' ? '/upload-online/ip-payments' : '/upload-online/diag-op-payments';
    this.router.navigate([base, batch.id]);
  }

  protected fileSizeLabel(bytes: number): string {
    return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}
