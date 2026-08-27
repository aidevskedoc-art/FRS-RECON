import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { animate, style, transition, trigger } from '@angular/animations';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';
import { TooltipModule } from 'primeng/tooltip';
import { OverlayBadgeModule } from 'primeng/overlaybadge';
import { AiStatusComponent } from '../../features/insurance-policy/shared/ai-status/ai-status.component';
import { ThemeStore } from '../../core/state/theme.store';
import { PolicyDocumentService } from '../../core/services/policy-document.service';
import { AuthService } from '../../core/services/auth.service';
import { MagneticDirective } from '../../shared/motion/magnetic.directive';
import { resolveRouteTitle } from '../../core/config/route-titles';
import { ReducedMotionService } from '../../core/a11y/reduced-motion';
import { SidebarStore } from '../sidebar/sidebar.store';

/**
 * The floating glass topbar: a three-column grid of masthead / route title /
 * actions.
 *
 * The masthead deliberately uses flat serif ink rather than the AI gradient —
 * an official-letterhead counterweight to the electric palette, so the app
 * still reads as a system of record.
 */
@Component({
  selector: 'app-topbar',
  standalone: true,
  imports: [
    RouterLink,
    TooltipModule,
    OverlayBadgeModule,
    AiStatusComponent,
    MagneticDirective,
  ],
  templateUrl: './topbar.component.html',
  styleUrl: './topbar.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'app-topbar-host' },
  animations: [
    // The centre title re-animates on every navigation.
    trigger('titleSwap', [
      transition('* => *', [
        style({ opacity: 0, transform: 'translateY(6px)' }),
        animate('220ms cubic-bezier(0.2, 0.8, 0.2, 1)', style({ opacity: 1, transform: 'translateY(0)' })),
      ]),
    ]),
  ],
})
export class TopbarComponent {
  private readonly router = inject(Router);
  protected readonly themeStore = inject(ThemeStore);
  protected readonly policyDocuments = inject(PolicyDocumentService);
  protected readonly sidebarStore = inject(SidebarStore);
  protected readonly authService = inject(AuthService);
  protected readonly reducedMotion = inject(ReducedMotionService);

  private readonly url = signal(this.router.url);
  protected readonly routeTitle = computed(() => resolveRouteTitle(this.url()));

  protected readonly menuOpen = signal(false);

  protected readonly initials = computed(() => this.authService.userId()?.slice(0, 2).toUpperCase() ?? '');
  protected readonly role = computed(() =>
    this.authService.isSuperAdmin() ? 'Super Admin' : 'Insurance Operations',
  );

  constructor() {
    this.router.events
      .pipe(
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe((event) => {
        this.url.set(event.urlAfterRedirects);
        this.menuOpen.set(false);
      });
  }

  protected toggleMenu(): void {
    this.menuOpen.update((open) => !open);
  }

  protected logout(): void {
    this.menuOpen.set(false);
    this.authService.logout();
    this.router.navigateByUrl('/login');
  }
}
