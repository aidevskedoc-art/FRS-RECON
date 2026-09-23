import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { animate, style, transition, trigger } from '@angular/animations';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';
import { TooltipModule } from 'primeng/tooltip';
import { OverlayBadgeModule } from 'primeng/overlaybadge';
import { ThemeStore } from '../../core/state/theme.store';
import { PolicyDocumentService } from '../../core/services/policy-document.service';
import { AuthService } from '../../core/services/auth.service';
import { resolveRouteTitle } from '../../core/config/route-titles';
import { APP_NAME, APP_SHORT_NAME } from '../../core/config/app-name';
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
  imports: [RouterLink, TooltipModule, OverlayBadgeModule],
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
  protected readonly appShortName = APP_SHORT_NAME;
  protected readonly appName = APP_NAME;
  private readonly router = inject(Router);
  protected readonly themeStore = inject(ThemeStore);
  protected readonly policyDocuments = inject(PolicyDocumentService);
  protected readonly sidebarStore = inject(SidebarStore);
  protected readonly authService = inject(AuthService);
  protected readonly reducedMotion = inject(ReducedMotionService);

  private readonly url = signal(this.router.url);
  protected readonly routeTitle = computed(() => resolveRouteTitle(this.url()));

  protected readonly menuOpen = signal(false);

  protected readonly initials = computed(() => {
    const fullName = this.authService.fullName();
    if (fullName) {
      const parts = fullName.replace(/^(Mrs?|Ms|Dr)\.?\s*/i, '').split(/\s+/).filter(Boolean);
      return parts.slice(0, 2).map((p) => p[0]).join('').toUpperCase();
    }
    return this.authService.userId()?.slice(0, 2).toUpperCase() ?? '';
  });
  protected readonly role = computed(() => this.authService.frsRole() ?? '');

  constructor() {
    this.authService.refreshProfile();
    this.router.events
      .pipe(
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe((event) => {
        this.url.set(event.urlAfterRedirects);
        this.menuOpen.set(false);
        // Keeps the identity panel current — e.g. a reporting manager assigned
        // in User Management shows up on the next page change, no re-login.
        this.authService.refreshProfile();
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
