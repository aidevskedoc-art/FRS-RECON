import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { animate, style, transition, trigger } from '@angular/animations';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';
import { SidebarComponent } from '../sidebar/sidebar.component';
import { TopbarComponent } from '../topbar/topbar.component';
import { AuroraBackgroundComponent } from '../../shared/ambient/aurora-background.component';
import { CursorGlowComponent } from '../../shared/ambient/cursor-glow.component';
import { SidebarStore } from '../sidebar/sidebar.store';
import { ReducedMotionService } from '../../core/a11y/reduced-motion';

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
  imports: [RouterOutlet, SidebarComponent, TopbarComponent, AuroraBackgroundComponent, CursorGlowComponent],
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

  constructor() {
    this.router.events
      .pipe(
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.routeKey.update((n) => n + 1));
  }
}
