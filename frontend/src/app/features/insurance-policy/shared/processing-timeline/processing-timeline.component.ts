import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { PROCESSING_STEPS, PROCESSING_STEP_META, ProcessingStep } from '../../../../core/models';

interface TimelineEntry {
  step: ProcessingStep;
  order: number;
  label: string;
  description: string;
  state: 'done' | 'active' | 'pending';
}

@Component({
  selector: 'app-processing-timeline',
  standalone: true,
  templateUrl: './processing-timeline.component.html',
  styleUrl: './processing-timeline.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'app-processing-timeline-host' },
})
export class ProcessingTimelineComponent {
  readonly currentStep = input.required<ProcessingStep>();
  readonly failed = input(false);

  protected readonly entries = computed<TimelineEntry[]>(() => {
    const currentOrder = PROCESSING_STEP_META[this.currentStep()].order;
    return PROCESSING_STEPS.map((step) => {
      const meta = PROCESSING_STEP_META[step];
      const state: TimelineEntry['state'] =
        meta.order < currentOrder ? 'done' : meta.order === currentOrder ? 'active' : 'pending';
      return { step, order: meta.order, label: meta.label, description: meta.description, state };
    });
  });
}
