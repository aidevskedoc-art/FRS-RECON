import { ChangeDetectionStrategy, Component, input, model } from '@angular/core';
import { DialogModule } from 'primeng/dialog';
import { RuleExplanation } from './rule-explanation.model';

/**
 * "Rule details" — one matching rule explained in plain language with worked
 * examples. Opened from the conditions/settings cell of any Manage Rules tab.
 * Purely presentational: the wording is built by explain-matching-rule.ts /
 * explain-gateway-rule.ts from the rule itself.
 */
@Component({
  selector: 'app-rule-details',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DialogModule],
  templateUrl: './rule-details.component.html',
  styleUrl: './rule-details.component.scss',
})
export class RuleDetailsComponent {
  readonly explanation = input<RuleExplanation | null>(null);
  readonly visible = model(false);
}
