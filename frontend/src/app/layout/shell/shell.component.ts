import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { animate, style, transition, trigger } from '@angular/animations';
import {
  NavigationCancel,
  NavigationEnd,
  NavigationError,
  NavigationSkipped,
  NavigationStart,
  Router,
  RouterOutlet,
} from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';
import { SidebarComponent, NAV_GROUPS } from '../sidebar/sidebar.component';
import { TopbarComponent } from '../topbar/topbar.component';
import { AuroraBackgroundComponent } from '../../shared/ambient/aurora-background.component';
import { CursorGlowComponent } from '../../shared/ambient/cursor-glow.component';
import { SidebarStore } from '../sidebar/sidebar.store';
import { ReducedMotionService } from '../../core/a11y/reduced-motion';
import { AiLoaderComponent } from '../../shared/ui/ai-loader.component';
import { ScanBannerComponent } from '../scan-banner/scan-banner.component';

/** The nav rail's own label for whichever link's path prefixes `path` most specifically — null off-nav (a drill-down/detail route). */
function navLabelFor(path: string): string | null {
  let label: string | null = null;
  let bestLength = -1;
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (path.startsWith(item.path) && item.path.length > bestLength) {
        label = item.label;
        bestLength = item.path.length;
      }
    }
  }
  return label;
}

/**
 * The persistent app shell: a CSS-grid frame whose sidebar and topbar are
 * detached floating glass panels, over the fixed ambient aurora.
 *
 * The grid itself is transparent — the aurora is mounted once here, behind
 * everything, and the body paints the ground colour. Nothing in the ambient
 * layer intercepts input.
 */
@Component({
  selector: 'app-shell',
  standalone: true,
  imports: [RouterOutlet, SidebarComponent, TopbarComponent, AuroraBackgroundComponent, CursorGlowComponent, AiLoaderComponent, ScanBannerComponent],
  templateUrl: './shell.component.html',
  styleUrl: './shell.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'app-shell-host' },
  animations: [
    // Page enter on every navigation. This runs through the Web Animations
    // API, which the global prefers-reduced-motion CSS override cannot reach —
    // hence the explicit [@.disabled] binding in the template.
    trigger('routeFade', [
      transition('* => *', [
        style({ opacity: 0, transform: 'translateY(10px)' }),
        animate('260ms cubic-bezier(0.2, 0.8, 0.2, 1)', style({ opacity: 1, transform: 'translateY(0)' })),
      ]),
    ]),
  ],
})
export class ShellComponent {
  protected readonly sidebarStore = inject(SidebarStore);
  protected readonly reducedMotion = inject(ReducedMotionService);
  private readonly router = inject(Router);

  /** Bumped on every navigation so the routeFade trigger re-fires. */
  protected readonly routeKey = signal(0);

  /**
   * The top bar slims down (52 -> 40px) once the page is scrolled into its
   * content, and comes back at the top — more rows on a laptop screen without
   * a button anyone has to remember. Two thresholds so it doesn't flicker
   * around a single scroll position.
   */
  protected readonly compact = signal(false);

  protected onContentScroll(event: Event): void {
    const top = (event.target as HTMLElement).scrollTop;
    if (!this.compact() && top > 48) this.compact.set(true);
    else if (this.compact() && top < 8) this.compact.set(false);
  }

  /**
   * Full-screen loader for a genuine page change (a different lazy-loaded
   * route, not just a tab/filter's query-param navigation on the page
   * you're already on). Delayed so an already-cached chunk — the common
   * case after the first visit — never flashes it.
   */
  protected readonly navigating = signal(false);
  protected readonly navigatingLabel = signal<string | null>(null);
  private navigatingTimer: ReturnType<typeof setTimeout> | null = null;
  private currentPath = this.router.url.split('?')[0];

  constructor() {
    this.router.events
      .pipe(
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.routeKey.update((n) => n + 1));

    this.router.events.pipe(takeUntilDestroyed()).subscribe((event) => {
      if (event instanceof NavigationStart) {
        const targetPath = event.url.split('?')[0];
        if (targetPath === this.currentPath) return;
        this.navigatingTimer = setTimeout(() => {
          this.navigatingLabel.set(navLabelFor(targetPath));
          this.navigating.set(true);
        }, 200);
        return;
      }
      if (event instanceof NavigationEnd) {
        this.currentPath = event.urlAfterRedirects.split('?')[0];
      }
      if (
        event instanceof NavigationEnd ||
        event instanceof NavigationCancel ||
        event instanceof NavigationError ||
        event instanceof NavigationSkipped
      ) {
        if (this.navigatingTimer) {
          clearTimeout(this.navigatingTimer);
          this.navigatingTimer = null;
        }
        this.navigating.set(false);
      }
    });
  }
}
