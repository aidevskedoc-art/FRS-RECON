import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { Policy } from '../../../../core/models';

@Component({
  selector: 'app-policy-summary',
  standalone: true,
  imports: [DecimalPipe],
  templateUrl: './policy-summary.component.html',
  styleUrl: './policy-summary.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'app-policy-summary-host' },
})
export class PolicySummaryComponent {
  readonly policy = input.required<Policy>();
}
