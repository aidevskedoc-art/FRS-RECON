import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';
import { TooltipModule } from 'primeng/tooltip';
import { AuthService } from '../../core/services/auth.service';
import { MagneticDirective } from '../../shared/motion/magnetic.directive';
import { SidebarStore } from './sidebar.store';

interface NavItem {
  label: string;
  icon: string;
  path: string;
}

interface NavGroup {
  label: string;
  /** Key into the --nav-color/grad/soft/line-* token sets in _nav-accents.scss. */
  accent: 'insurance' | 'online' | 'rules' | 'masters' | 'admin' | 'reports' | 'support';
  items: NavItem[];
  /**
   * Extra path prefixes this group owns without listing a link for them —
   * drill-downs and off-nav pages. Without these the rail has nothing to match
   * on such a route and simply keeps whichever group was last open, so the
   * document workspace would sit under a stale section and accent colour.
   */
  owns?: readonly string[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    // The whole reconciliation workflow, front to back: upload everything, see
    // every uploaded batch, see every result, manage every rule — four
    // screens, each already tabbed internally by type. Nothing per-type is
    // listed here any more; the tabs are the detail.
    label: 'Reconciliation',
    accent: 'rules',
    // The off-nav legacy MIS archive is otherwise unreachable from the rail.
    owns: ['/upload-online/payments'],
    items: [
      { label: 'Upload & Run', icon: 'pi pi-play-circle', path: '/reconciliation' },
      { label: 'Statements', icon: 'pi pi-book', path: '/upload-online/statements' },
      { label: 'Reconciliation Results', icon: 'pi pi-chart-bar', path: '/matched-rules/results' },
      { label: 'Manage Rules', icon: 'pi pi-sliders-h', path: '/matched-rules/manage-rules' },
    ],
  },
  {
    label: 'Master Data',
    accent: 'masters',
    items: [{ label: 'Division & Bank A/C', icon: 'pi pi-sitemap', path: '/master-data/division-bank-accounts' }],
  },
  {
    // A separate product that happens to share this shell — not part of the
    // reconciliation workflow above, so it sits near the bottom rather than
    // leading the rail. It is also the only section a non-Super-Admin can
    // reach, which is why superAdminGuard falls back to its dashboard.
    label: 'Automation Insurance',
    accent: 'insurance',
    // '/insurance-policy/processing' and the documents/:id/* workspace steps.
    owns: ['/insurance-policy'],
    items: [
      { label: 'Dashboard', icon: 'pi pi-th-large', path: '/insurance-policy/dashboard' },
      { label: 'Upload Documents', icon: 'pi pi-cloud-upload', path: '/insurance-policy/upload' },
      { label: 'Excel Export', icon: 'pi pi-file-excel', path: '/insurance-policy/excel-preview' },
      { label: 'Processing History', icon: 'pi pi-history', path: '/insurance-policy/history' },
    ],
  },
  {
    // The operating guide for the reconciliation workflow. `admin` is the one
    // accent _nav-accents.scss defines that no nav group had claimed.
    label: 'Help',
    accent: 'admin',
    items: [{ label: 'How to Use', icon: 'pi pi-compass', path: '/how-to-use' }],
  },
];

/**
 * The floating glass navigation rail.
 *
 * Three behaviours beyond plain links:
 *   - Accordion groups, one open at a time, with the group owning the active
 *     route auto-opened on navigation.
 *   - A single active-indicator pill that physically slides between items
 *     rather than appearing under each one, painted with the active section's
 *     accent. Its position is measured from the DOM because the items it
 *     travels between are inside a height-animating accordion.
 *   - Per-section accents, so the rail tells you which module you're in
 *     before you read a label.
 */
@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [RouterLink, RouterLinkActive, TooltipModule, MagneticDirective],
  templateUrl: './sidebar.component.html',
  styleUrl: './sidebar.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'app-sidebar-host' },
})
export class SidebarComponent {
  protected readonly sidebarStore = inject(SidebarStore);
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  private readonly navRef = viewChild<ElementRef<HTMLElement>>('nav');

  protected readonly navGroups = computed(() =>
    this.authService.isSuperAdmin() ? NAV_GROUPS : NAV_GROUPS.filter((g) => g.label === 'Automation Insurance'),
  );

  /** Only one group is open at a time. */
  protected readonly expandedGroup = signal<string | null>(null);

  /** Measured geometry of the sliding active pill. */
  protected readonly indicatorTop = signal(0);
  protected readonly indicatorHeight = signal(0);
  protected readonly indicatorVisible = signal(false);
  /** Accent key of the group containing the active route. */
  protected readonly activeAccent = signal<string>('insurance');

  private measureHandle = 0;
  private destroyed = false;

  constructor() {
    this.syncToUrl(this.router.url);

    this.router.events
      .pipe(
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe((event) => {
        this.syncToUrl(event.urlAfterRedirects);
        this.scheduleMeasure();
      });

    // Opening/closing a group and collapsing the rail both move the active
    // item, so the pill has to be re-measured after each.
    effect(() => {
      this.expandedGroup();
      this.sidebarStore.collapsed();
      this.scheduleMeasure();
    });

    afterNextRender(() => {
      const nav = this.navRef()?.nativeElement;
      if (!nav) {
        return;
      }

      // The accordion animates grid-template-rows; the pill can only land
      // correctly once that transition has actually finished.
      const onTransitionEnd = (event: TransitionEvent) => {
        if (event.propertyName === 'grid-template-rows') {
          this.measure();
        }
      };
      nav.addEventListener('transitionend', onTransitionEnd);

      // Everything else that moves the rows under an already-placed pill:
      // the window resizing, the rail collapsing, a scrollbar appearing once
      // a tall group opens. None of those fire a transitionend on the nav,
      // so without this the pill silently keeps its stale position.
      const resizeObserver = new ResizeObserver(() => this.scheduleMeasure());
      resizeObserver.observe(nav);

      // Row heights come from the display font, so the first measurement is
      // taken against fallback metrics and goes stale the moment it swaps.
      document.fonts.ready.then(() => this.scheduleMeasure());

      this.destroyRef.onDestroy(() => {
        this.destroyed = true;
        nav.removeEventListener('transitionend', onTransitionEnd);
        resizeObserver.disconnect();
        cancelAnimationFrame(this.measureHandle);
      });
      this.scheduleMeasure();
    });
  }

  protected toggleGroup(label: string): void {
    this.expandedGroup.update((current) => (current === label ? null : label));
  }

  protected isExpanded(label: string): boolean {
    return this.expandedGroup() === label;
  }

  /**
   * Opens the group that owns the current URL and adopts its accent.
   *
   * Matched by longest prefix, not first hit. These are raw string prefixes,
   * so a shorter `owns` entry never outranks a real link with a longer path
   * that starts the same way (e.g. '/insurance-policy' vs
   * '/insurance-policy/dashboard' below) — a first-match scan could otherwise
   * land on the wrong group.
   */
  private syncToUrl(url: string): void {
    let bestGroup: NavGroup | null = null;
    let bestLength = -1;

    for (const group of this.navGroups()) {
      // `owns` prefixes join the same scan rather than acting as a fallback:
      // they are shorter than the links they sit above ('/insurance-policy'
      // vs '/insurance-policy/dashboard'), so a real link always outranks
      // them and they only decide the routes no link covers.
      for (const path of [...group.items.map((i) => i.path), ...(group.owns ?? [])]) {
        if (url.startsWith(path) && path.length > bestLength) {
          bestGroup = group;
          bestLength = path.length;
        }
      }
    }

    if (bestGroup) {
      this.expandedGroup.set(bestGroup.label);
      this.activeAccent.set(bestGroup.accent);
    }
  }

  private scheduleMeasure(): void {
    if (this.destroyed) {
      return;
    }
    cancelAnimationFrame(this.measureHandle);
    this.measureHandle = requestAnimationFrame(() => this.measure());
  }

  /**
   * routerLinkActive matches by URL segment and is not exact, so a link stays
   * active across its child routes — which is what keeps 'IP Payments' lit
   * while you're inside a batch detail, and 'IP Payment Rules' lit on its
   * '/manage' child. No two nav paths currently nest, but if one ever does the
   * indicator belongs on the most specific match, which is the longest href.
   */
  private activeLink(nav: HTMLElement): HTMLElement | undefined {
    return Array.from(nav.querySelectorAll<HTMLElement>('.sidebar__link--active'))
      .sort((a, b) => (a.getAttribute('href')?.length ?? 0) - (b.getAttribute('href')?.length ?? 0))
      .pop();
  }

  private measure(): void {
    const nav = this.navRef()?.nativeElement;
    const active = nav ? this.activeLink(nav) : undefined;
    if (!nav || !active) {
      this.indicatorVisible.set(false);
      return;
    }

    const navRect = nav.getBoundingClientRect();
    const linkRect = active.getBoundingClientRect();

    // Only one group is open at a time, so the active route's link is often
    // inside a closed one — and a closed group only clips its container to
    // zero height, it does not take the rows out of layout. The link still
    // reports a perfectly plausible position, which is how the pill ends up
    // parked over some unrelated group. The clip rect is the only thing that
    // knows whether the row is really on screen.
    const clip = active.closest<HTMLElement>('.sidebar__group-items');
    if (clip) {
      const clipRect = clip.getBoundingClientRect();
      if (linkRect.bottom <= clipRect.top + 1 || linkRect.top >= clipRect.bottom - 1) {
        this.indicatorVisible.set(false);
        return;
      }
    }

    // Rects are viewport-relative, while the pill is absolutely positioned
    // against the nav's padding box and scrolls with its content — so the
    // border width and the scroll offset both have to be added back to land
    // in that space. offsetTop agrees only for as long as nothing between a
    // link and the nav is positioned, which nothing in the template enforces.
    this.indicatorTop.set(linkRect.top - navRect.top - nav.clientTop + nav.scrollTop);
    this.indicatorHeight.set(linkRect.height);
    this.indicatorVisible.set(true);
  }
}
