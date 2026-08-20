import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { PasswordModule } from 'primeng/password';
import { AiStatusComponent } from '../../insurance-policy/shared/ai-status/ai-status.component';
import { AuthService } from '../../../core/services/auth.service';

interface Particle {
  left: number;
  size: number;
  duration: number;
  delay: number;
  drift: number;
}

const TAGLINES = [
  'Extracting policy data with AI precision.',
  'Turning scanned PDFs into structured Excel.',
  'Validation, confidence-scored in seconds.',
  'Audit-ready output, every single time.',
];

const FEATURES = [
  { icon: 'pi pi-bolt', text: 'AI-powered extraction in seconds, not hours' },
  { icon: 'pi pi-verified', text: 'Confidence-scored, audit-ready accuracy' },
  { icon: 'pi pi-file-excel', text: 'One-click Excel automation' },
];

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [ReactiveFormsModule, ButtonModule, InputTextModule, PasswordModule, AiStatusComponent],
  templateUrl: './login.component.html',
  styleUrl: './login.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'app-login-host',
    '(mousemove)': 'onPointerMove($event)',
  },
})
export class LoginComponent {
  private readonly fb = inject(FormBuilder);
  private readonly router = inject(Router);
  private readonly authService = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly submitting = signal(false);
  protected readonly loginError = signal<string | null>(null);
  protected readonly shake = signal(false);
  protected readonly passwordVisible = signal(false);
  protected readonly taglineIndex = signal(0);

  protected readonly taglines = TAGLINES;
  protected readonly features = FEATURES;
  protected readonly particles: Particle[] = Array.from({ length: 22 }, (_, i) => {
    const seed = (i * 137.5) % 100;
    return {
      left: seed,
      size: 2 + ((i * 7) % 5),
      duration: 10 + ((i * 5) % 12),
      delay: -((i * 3) % 14),
      drift: ((i % 2 === 0 ? 1 : -1) * (10 + (i % 4) * 8)),
    };
  });

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

  protected onPointerMove(event: MouseEvent): void {
    const host = event.currentTarget as HTMLElement;
    const x = (event.clientX / host.clientWidth) * 100;
    const y = (event.clientY / host.clientHeight) * 100;
    host.style.setProperty('--pointer-x', `${x}%`);
    host.style.setProperty('--pointer-y', `${y}%`);
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

      this.router.navigateByUrl('/insurance-policy/dashboard');
    }, 450);
  }

  private triggerShake(): void {
    this.shake.set(false);
    requestAnimationFrame(() => this.shake.set(true));
    setTimeout(() => this.shake.set(false), 420);
  }
}
