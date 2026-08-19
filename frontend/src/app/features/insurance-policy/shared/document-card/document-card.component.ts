import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { ButtonModule } from 'primeng/button';
import { TooltipModule } from 'primeng/tooltip';
import { DOCUMENT_STATUS_META, PolicyDocument } from '../../../../core/models';

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

@Component({
  selector: 'app-document-card',
  standalone: true,
  imports: [ButtonModule, TooltipModule],
  templateUrl: './document-card.component.html',
  styleUrl: './document-card.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'app-document-card-host' },
})
export class DocumentCardComponent {
  readonly document = input.required<PolicyDocument>();
  readonly removable = input(true);

  readonly open = output<void>();
  readonly remove = output<void>();
  readonly retry = output<void>();

  protected readonly meta = computed(() => DOCUMENT_STATUS_META[this.document().status]);
  protected readonly fileSizeLabel = computed(() => formatFileSize(this.document().fileSizeBytes));
  protected readonly isBusy = computed(() =>
    ['Scanning', 'Extracting', 'Validating'].includes(this.document().status),
  );
}
