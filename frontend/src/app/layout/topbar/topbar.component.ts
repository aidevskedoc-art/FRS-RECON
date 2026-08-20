import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TooltipModule } from 'primeng/tooltip';
import { OverlayBadgeModule } from 'primeng/overlaybadge';
import { AiStatusComponent } from '../../features/insurance-policy/shared/ai-status/ai-status.component';
import { ThemeStore } from '../../core/state/theme.store';
import { PolicyDocumentService } from '../../core/services/policy-document.service';
import { AuthService } from '../../core/services/auth.service';
import { SidebarStore } from '../sidebar/sidebar.store';

@Component({
  selector: 'app-topbar',
  standalone: true,
  imports: [ButtonModule, TooltipModule, OverlayBadgeModule, AiStatusComponent],
  templateUrl: './topbar.component.html',
  styleUrl: './topbar.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'app-topbar-host' },
})
export class TopbarComponent {
  private readonly router = inject(Router);
  protected readonly themeStore = inject(ThemeStore);
  protected readonly policyDocuments = inject(PolicyDocumentService);
  protected readonly sidebarStore = inject(SidebarStore);
  protected readonly authService = inject(AuthService);

  protected logout(): void {
    this.authService.logout();
    this.router.navigateByUrl('/login');
  }
}
