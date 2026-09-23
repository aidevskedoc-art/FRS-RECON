import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { InputTextModule } from 'primeng/inputtext';
import { PasswordModule } from 'primeng/password';
import { AiStatusComponent } from '../../insurance-policy/shared/ai-status/ai-status.component';
import { AuthService } from '../../../core/services/auth.service';
import { LANDING_PATH } from '../../../core/guards/auth.guard';
import { APP_NAME, APP_SHORT_NAME } from '../../../core/config/app-name';
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
  protected readonly appShortName = APP_SHORT_NAME;
  protected readonly appName = APP_NAME;
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

    this.authService.login(userId.trim(), password).subscribe((result) => {
      this.submitting.set(false);

      if (!result.ok) {
        this.loginError.set(result.error ?? 'Invalid User ID or Password.');
        this.triggerShake();
        return;
      }

      // A fresh account (or one an Admin just reset) goes to /change-password
      // first — mustChangePasswordGuard would bounce it there anyway, but
      // routing directly skips a pointless extra redirect.
      if (result.mustChangePassword) {
        this.router.navigateByUrl('/change-password');
        return;
      }

      // Every signed-in user lands on the overview dashboard first.
      this.router.navigateByUrl(LANDING_PATH);
    });
  }

  private triggerShake(): void {
    // Clearing first, then re-setting on the next frame, is what restarts the
    // CSS animation — re-adding a class in the same frame does nothing.
    this.shake.set(false);
    requestAnimationFrame(() => this.shake.set(true));
    setTimeout(() => this.shake.set(false), 420);
  }
}
