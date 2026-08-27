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
  /** Key into the --nav-color/grad/soft-* token triplets in _nav-accents.scss. */
  accent: 'insurance' | 'online' | 'rules' | 'masters' | 'admin' | 'reports' | 'support';
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Automation Insurance',
    accent: 'insurance',
    items: [
      { label: 'Dashboard', icon: 'pi pi-th-large', path: '/insurance-policy/dashboard' },
      { label: 'Upload Documents', icon: 'pi pi-cloud-upload', path: '/insurance-policy/upload' },
      { label: 'Excel Export', icon: 'pi pi-file-excel', path: '/insurance-policy/excel-preview' },
      { label: 'Processing History', icon: 'pi pi-history', path: '/insurance-policy/history' },
    ],
  },
  {
    label: 'Upload Online',
    accent: 'online',
    items: [
      { label: 'Upload MIS Data', icon: 'pi pi-cloud-upload', path: '/upload-online/mis' },
      { label: 'Upload Bank Statement', icon: 'pi pi-building-columns', path: '/upload-online/bank-statement' },
      { label: 'View IP & Diag Payments', icon: 'pi pi-list', path: '/upload-online/payments' },
      { label: 'New Online Payments', icon: 'pi pi-wallet', path: '/upload-online/ip-payments' },
      { label: 'View Diag OP Payments', icon: 'pi pi-heart', path: '/upload-online/diag-op-payments' },
      { label: 'View Bank Statements', icon: 'pi pi-book', path: '/upload-online/bank-statements' },
    ],
  },
  {
    label: 'Master Data',
    accent: 'masters',
    items: [{ label: 'Division & Bank A/C', icon: 'pi pi-sitemap', path: '/master-data/division-bank-accounts' }],
  },
  {
    label: 'Matched Rules',
    accent: 'rules',
    items: [
      { label: 'Reconciliation Summary', icon: 'pi pi-chart-bar', path: '/matched-rules/summary' },
      { label: 'IP Payment Rules', icon: 'pi pi-verified', path: '/matched-rules/ip-payment-rules' },
      { label: 'Diagnostics Payment Rules', icon: 'pi pi-verified', path: '/matched-rules/diagnostics-payment-rules' },
    ],
  },
  {
    label: 'Master Rules',
    accent: 'admin',
    items: [
      { label: 'Manage IP Payment Rules', icon: 'pi pi-cog', path: '/matched-rules/ip-payment-rules/manage' },
      {
        label: 'Manage Diagnostics Payment Rules',
        icon: 'pi pi-cog',
        path: '/matched-rules/diagnostics-payment-rules/manage',
      },
    ],
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
      // The accordion animates max-height; the pill can only land correctly
      // once that transition has actually finished.
      const onTransitionEnd = (event: TransitionEvent) => {
        if (event.propertyName === 'max-height') {
          this.measure();
        }
      };
      nav?.addEventListener('transitionend', onTransitionEnd);
      this.destroyRef.onDestroy(() => {
        nav?.removeEventListener('transitionend', onTransitionEnd);
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
   * Matched by longest prefix, not first hit: '/matched-rules/ip-payment-rules'
   * (Matched Rules) is a prefix of '/matched-rules/ip-payment-rules/manage'
   * (Master Rules), and a first-match scan would open the wrong group for
   * every 'manage' route.
   */
  private syncToUrl(url: string): void {
    let bestGroup: NavGroup | null = null;
    let bestLength = -1;

    for (const group of this.navGroups()) {
      for (const item of group.items) {
        if (url.startsWith(item.path) && item.path.length > bestLength) {
          bestGroup = group;
          bestLength = item.path.length;
        }
      }
    }

    if (bestGroup) {
      this.expandedGroup.set(bestGroup.label);
      this.activeAccent.set(bestGroup.accent);
    }
  }

  private scheduleMeasure(): void {
    cancelAnimationFrame(this.measureHandle);
    this.measureHandle = requestAnimationFrame(() => this.measure());
  }

  private measure(): void {
    const nav = this.navRef()?.nativeElement;
    if (!nav) {
      this.indicatorVisible.set(false);
      return;
    }

    // routerLinkActive is prefix-based, so '/matched-rules/ip-payment-rules'
    // is also "active" while you're on its '/manage' child. More than one
    // link can therefore carry the active class; the indicator belongs on
    // the most specific one, which is the longest matching path.
    const active = Array.from(nav.querySelectorAll<HTMLElement>('.sidebar__link--active'))
      .sort((a, b) => (a.getAttribute('href')?.length ?? 0) - (b.getAttribute('href')?.length ?? 0))
      .pop();

    if (!active) {
      this.indicatorVisible.set(false);
      return;
    }
    this.indicatorTop.set(active.offsetTop);
    this.indicatorHeight.set(active.offsetHeight);
    this.indicatorVisible.set(true);
  }
}
