import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { TooltipModule } from 'primeng/tooltip';
import { CONFIDENCE_META, ConfidenceLevel } from '../../../../core/models';

@Component({
  selector: 'app-confidence-indicator',
  standalone: true,
  imports: [TooltipModule],
  templateUrl: './confidence-indicator.component.html',
  styleUrl: './confidence-indicator.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'app-confidence-indicator-host' },
})
export class ConfidenceIndicatorComponent {
  readonly level = input.required<ConfidenceLevel>();
  readonly score = input<number | null>(null);
  readonly verified = input(false);
  readonly compact = input(false);

  protected readonly meta = computed(() => CONFIDENCE_META[this.level()]);

  protected readonly tooltipText = computed(() =>
    this.verified() ? 'Verified by you.' : 'AI extracted value – verify before saving',
  );
}
