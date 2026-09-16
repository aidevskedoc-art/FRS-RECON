import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { InputTextModule } from 'primeng/inputtext';
import { PasswordModule } from 'primeng/password';
import { AiStatusComponent } from '../../insurance-policy/shared/ai-status/ai-status.component';
import { AuthService } from '../../../core/services/auth.service';
import { AuroraBackgroundComponent } from '../../../shared/ambient/aurora-background.component';
import { CursorGlowComponent } from '../../../shared/ambient/cursor-glow.component';
import { MagneticDirective } from '../../../shared/motion/magnetic.directive';

const TAGLINES = [
  'Matching payments to bank statements, automatically.',
  'MIS data, bank statements, and matching rules in one workspace.',
  'Insurance policy automation is one module of many.',
  'Audit-ready reconciliation output, every single time.',
];

const FEATURES = [
  { icon: 'pi pi-sync', text: 'Automated matching across payments and bank statements' },
  { icon: 'pi pi-verified', text: 'Confidence-scored, audit-ready reconciliation' },
  { icon: 'pi pi-th-large', text: 'Insurance automation — one module of the platform' },
];

/** Static module strip shown at the foot of the hero — Insurance is the entry module. */
const MODULES = [
  { label: 'Insurance Automation', active: true },
  { label: 'Online Payments', active: false },
  { label: 'Matching Rules', active: false },
  { label: 'Master Data', active: false },
];

/**
 * Auth screen — the AI Glass "centred glass card over the live aurora"
 * archetype, widened to a two-panel split so the product's own copy has
 * somewhere to live.
 *
 * The ambient layers are mounted here directly because login sits outside
 * the app shell, which is what normally provides them.
 */
@Component({
  selector: 'app-login',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    InputTextModule,
    PasswordModule,
    AiStatusComponent,
    AuroraBackgroundComponent,
    CursorGlowComponent,
    MagneticDirective,
  ],
  templateUrl: './login.component.html',
  styleUrl: './login.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'app-login-host' },
})
export class LoginComponent {
  private readonly fb = inject(FormBuilder);
  private readonly router = inject(Router);
  private readonly authService = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly submitting = signal(false);
  protected readonly loginError = signal<string | null>(null);
  protected readonly shake = signal(false);
  protected readonly taglineIndex = signal(0);

  protected readonly taglines = TAGLINES;
  protected readonly features = FEATURES;
  protected readonly modules = MODULES;

  protected readonly form = this.fb.nonNullable.group({
    userId: ['', Validators.required],
    password: ['', Validators.required],
  });

  constructor() {
    const interval = setInterval(() => {
      this.taglineIndex.update((i) => (i + 1) % TAGLINES.length);
    }, 3400);
    this.destroyRef.onDestroy(() => clearInterval(interval));
  }

  protected submit(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.triggerShake();
      return;
    }

    this.submitting.set(true);
    this.loginError.set(null);
    const { userId, password } = this.form.getRawValue();

    setTimeout(() => {
      const success = this.authService.login(userId.trim(), password);
      this.submitting.set(false);

      if (!success) {
        this.loginError.set('Invalid User ID or Password.');
        this.triggerShake();
        return;
      }

      // Lands on the consolidated Reconciliation screen. A non-Super-Admin is
      // moved on to the insurance dashboard by superAdminGuard.
      this.router.navigateByUrl('/reconciliation');
    }, 450);
  }

  private triggerShake(): void {
    // Clearing first, then re-setting on the next frame, is what restarts the
    // CSS animation — re-adding a class in the same frame does nothing.
    this.shake.set(false);
    requestAnimationFrame(() => this.shake.set(true));
    setTimeout(() => this.shake.set(false), 420);
  }
}
