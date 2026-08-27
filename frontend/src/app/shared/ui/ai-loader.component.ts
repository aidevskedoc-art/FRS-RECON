import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * The full-screen work indicator.
 *
 * The rule this exists to enforce: every async action shows a loader whose
 * caption names the *real* work ("Matching payments · Applying rules"), not
 * a generic "Loading…". A caption that doesn't say what is happening is a
 * spinner with extra steps.
 *
 *   <app-ai-loader label="Reconciling" caption="Matching payments · Applying rules" />
 */
@Component({
  selector: 'app-ai-loader',
  standalone: true,
  template: `
    <div class="loader" role="status" [attr.aria-label]="label()">
      <div class="loader__core">
        <span class="loader__halo"></span>
        <span class="loader__ring loader__ring--outer"></span>
        <span class="loader__ring loader__ring--inner"></span>
        <span class="loader__orb"><i [class]="icon()"></i></span>
      </div>

      <p class="loader__label ai-gradient-text-shimmer ai-display">{{ label() }}</p>
      @if (caption()) {
        <p class="loader__caption">{{ caption() }}</p>
      }
    </div>
  `,
  styles: [
    `
      :host {
        position: fixed;
        inset: 0;
        z-index: var(--z-modal);
        display: grid;
        place-items: center;
        background: var(--overlay);
        backdrop-filter: blur(20px) saturate(150%);
        -webkit-backdrop-filter: blur(20px) saturate(150%);
        animation: fade-in 200ms var(--ease) both;
      }

      .loader {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: var(--space-4);
        text-align: center;
      }

      .loader__core {
        position: relative;
        display: grid;
        place-items: center;
        width: 112px;
        height: 112px;
      }

      .loader__halo,
      .loader__ring,
      .loader__orb {
        position: absolute;
        border-radius: 50%;
      }

      .loader__halo {
        inset: 0;
        background: radial-gradient(circle, var(--ai-aurora-1) 0%, var(--ai-aurora-3) 55%, transparent 72%);
        filter: blur(6px);
        animation: halo-pulse 2.6s ease-in-out infinite;
      }

      /* Two counter-rotating rings at different speeds — the offset is what
         makes the core read as a mechanism rather than a spinner. */
      .loader__ring--outer {
        width: 96px;
        height: 96px;
        border: 2px solid transparent;
        border-top-color: var(--ai-primary);
        border-right-color: var(--ai-ai);
        animation: spin 1.6s linear infinite;
      }

      .loader__ring--inner {
        width: 82px;
        height: 82px;
        border: 2px solid transparent;
        border-bottom-color: var(--ai-primary);
        border-left-color: var(--ai-ai);
        opacity: 0.6;
        animation: spin-reverse 2.8s linear infinite;
      }

      .loader__orb {
        display: grid;
        place-items: center;
        width: 66px;
        height: 66px;
        background: var(--ai-gradient);
        color: #fff;
        font-size: 1.2rem;
        box-shadow:
          0 10px 34px -10px rgba(79, 70, 229, 0.55),
          0 0 0 7px var(--brand-ring);
        animation: breathe 1.8s ease-in-out infinite;
      }

      .loader__label {
        margin: 0;
        font-size: 1.05rem;
        font-weight: 700;
      }

      .loader__caption {
        margin: 0;
        font-size: 0.78rem;
        font-weight: 600;
        color: var(--text-muted);
        max-width: 46ch;
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AiLoaderComponent {
  readonly label = input('Working');
  /** Name the actual work — "Extracting members · Validating totals". */
  readonly caption = input('');
  readonly icon = input('pi pi-sparkles');
}
