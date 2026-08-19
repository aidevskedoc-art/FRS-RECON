import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type AiStatusState = 'idle' | 'active' | 'error';

@Component({
  selector: 'app-ai-status',
  standalone: true,
  templateUrl: './ai-status.component.html',
  styleUrl: './ai-status.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'app-ai-status-host' },
})
export class AiStatusComponent {
  readonly state = input<AiStatusState>('active');
  readonly label = input('AI Engine Active');
}
