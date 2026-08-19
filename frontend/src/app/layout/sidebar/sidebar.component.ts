import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { TooltipModule } from 'primeng/tooltip';
import { SidebarStore } from './sidebar.store';

interface NavItem {
  label: string;
  icon: string;
  path: string;
}

const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', icon: 'pi pi-th-large', path: '/insurance-policy/dashboard' },
  { label: 'Upload Documents', icon: 'pi pi-cloud-upload', path: '/insurance-policy/upload' },
  { label: 'Excel Export', icon: 'pi pi-file-excel', path: '/insurance-policy/excel-preview' },
  { label: 'Processing History', icon: 'pi pi-history', path: '/insurance-policy/history' },
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
  protected readonly navItems = NAV_ITEMS;
}
