import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { PasswordModule } from 'primeng/password';
import { AuthService } from '../../../core/services/auth.service';
import { LANDING_PATH } from '../../../core/guards/auth.guard';
import { errorMessage } from '../../../core/services/policy-document.service';

/**
 * Mandatory interstitial between login and the app for any account still on
 * its temp password (must_change_password) — every one of the 5 real seeded
 * users starts here. Reached only via mustChangePasswordGuard; sits outside
 * the shell, same as /login, so there's no sidebar to tempt a way around it.
 */
@Component({
  selector: 'app-change-password',
  standalone: true,
  imports: [ReactiveFormsModule, PasswordModule],
  templateUrl: './change-password.component.html',
  styleUrl: './change-password.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChangePasswordComponent {
  private readonly fb = inject(FormBuilder);
  private readonly router = inject(Router);
  private readonly authService = inject(AuthService);

  protected readonly saving = signal(false);
  protected readonly formError = signal<string | null>(null);

  protected readonly form = this.fb.nonNullable.group({
    currentPassword: ['', Validators.required],
    newPassword: ['', [Validators.required, Validators.minLength(6)]],
    confirmPassword: ['', Validators.required],
  });

  protected submit(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const { currentPassword, newPassword, confirmPassword } = this.form.getRawValue();
    if (newPassword !== confirmPassword) {
      this.formError.set('New password and confirmation do not match.');
      return;
    }
    if (newPassword === currentPassword) {
      this.formError.set('New password must be different from your current password.');
      return;
    }

    this.saving.set(true);
    this.formError.set(null);
    this.authService.changePassword(currentPassword, newPassword).subscribe({
      next: () => {
        this.saving.set(false);
        this.router.navigateByUrl(LANDING_PATH);
      },
      error: (err) => {
        this.saving.set(false);
        this.formError.set(errorMessage(err));
      },
    });
  }
}
