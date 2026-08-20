import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { TooltipModule } from 'primeng/tooltip';
import { SidebarStore } from './sidebar.store';

interface NavItem {
  label: string;
  icon: string;
  path: string;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Automation Insurance',
    items: [
      { label: 'Dashboard', icon: 'pi pi-th-large', path: '/insurance-policy/dashboard' },
      { label: 'Upload Documents', icon: 'pi pi-cloud-upload', path: '/insurance-policy/upload' },
      { label: 'Excel Export', icon: 'pi pi-file-excel', path: '/insurance-policy/excel-preview' },
      { label: 'Processing History', icon: 'pi pi-history', path: '/insurance-policy/history' },
    ],
  },
];

@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [RouterLink, RouterLinkActive, TooltipModule],
  templateUrl: './sidebar.component.html',
  styleUrl: './sidebar.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'app-sidebar-host' },
})
export class SidebarComponent {
  protected readonly sidebarStore = inject(SidebarStore);
  protected readonly navGroups = NAV_GROUPS;
  protected readonly expandedGroups = signal<ReadonlySet<string>>(new Set());

  protected toggleGroup(label: string): void {
    const expanded = new Set(this.expandedGroups());
    if (expanded.has(label)) {
      expanded.delete(label);
    } else {
      expanded.add(label);
    }
    this.expandedGroups.set(expanded);
  }
}
