import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Table, TableModule } from 'primeng/table';
import { InputTextModule } from 'primeng/inputtext';
import { PasswordModule } from 'primeng/password';
import { SelectModule } from 'primeng/select';
import { MultiSelectModule } from 'primeng/multiselect';
import { DialogModule } from 'primeng/dialog';
import { TooltipModule } from 'primeng/tooltip';
import { AuthService } from '../../../core/services/auth.service';
import { UserManagementService } from '../../../core/services/user-management.service';
import { MasterDataService } from '../../../core/services/master-data.service';
import { errorMessage } from '../../../core/utils/error-message.util';
import { AuditLogEntry, FRS_ROLES, FrsRole, FrsUser } from '../../../core/models';
import { AUDITOR_DEFAULT_SCREENS, SCREENS, SCREEN_LABELS } from '../../../core/config/screens';
import { PageHeaderComponent } from '../../../shared/ui/page-header.component';
import { AuditLogComponent } from '../audit-log/audit-log.component';

type UsersTabId = 'users' | 'audit-log';

interface UsersTab {
  readonly id: UsersTabId;
  readonly label: string;
  readonly icon: string;
}

const TABS: readonly UsersTab[] = [
  { id: 'users', label: 'Users', icon: 'pi pi-users' },
  { id: 'audit-log', label: 'Audit Log', icon: 'pi pi-history' },
];

interface UserFormState {
  employeeId: string;
  fullName: string;
  password: string;
  role: FrsRole | null;
  managerId: string | null;
  email: string;
  mobileNumber: string;
  locations: string[];
  screenKeys: string[];
}

function emptyForm(): UserFormState {
  return {
    employeeId: '',
    fullName: '',
    password: '',
    role: 'Auditor',
    managerId: null,
    email: '',
    mobileNumber: '',
    locations: [],
    screenKeys: [...AUDITOR_DEFAULT_SCREENS],
  };
}

@Component({
  selector: 'app-users',
  standalone: true,
  imports: [
    DatePipe,
    FormsModule,
    TableModule,
    InputTextModule,
    PasswordModule,
    SelectModule,
    MultiSelectModule,
    DialogModule,
    TooltipModule,
    PageHeaderComponent,
    AuditLogComponent,
  ],
  templateUrl: './users.component.html',
  styleUrl: './users.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UsersComponent {
  protected readonly users = inject(UserManagementService);
  protected readonly masterData = inject(MasterDataService);
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly roles: FrsRole[] = [...FRS_ROLES];

  protected readonly tabs = TABS;
  protected readonly activeTab = signal<UsersTabId>(this.initialTab());

  protected readonly listError = signal<string | null>(null);

  // ---- create / edit dialog -------------------------------------------------
  protected readonly dialogVisible = signal(false);
  protected readonly editingId = signal<string | null>(null);
  protected readonly form = signal<UserFormState>(emptyForm());
  protected readonly formError = signal<string | null>(null);
  protected readonly saving = signal(false);

  // ---- branches dialog --------------------------------------------------------
  protected readonly branchesUser = signal<FrsUser | null>(null);
  protected readonly branchesDraft = signal<string[]>([]);
  protected readonly branchesSaving = signal(false);
  protected readonly branchesError = signal<string | null>(null);

  // ---- screen access dialog (URL-level access control) ----------------------------
  protected readonly screenOptions = SCREENS.map((s) => ({ label: s.label, value: s.key }));
  protected readonly screensUser = signal<FrsUser | null>(null);
  protected readonly screensDraft = signal<string[]>([]);
  protected readonly screensSaving = signal(false);
  protected readonly screensError = signal<string | null>(null);

  // ---- reset password dialog ---------------------------------------------------
  protected readonly resetUser = signal<FrsUser | null>(null);
  protected readonly resetPassword1 = signal('');
  protected readonly resetPassword2 = signal('');
  protected readonly resetSaving = signal(false);
  protected readonly resetError = signal<string | null>(null);

  // ---- activity (audit log) dialog ---------------------------------------------
  protected readonly activityUser = signal<FrsUser | null>(null);
  protected readonly activityLog = signal<AuditLogEntry[]>([]);
  protected readonly activityLoading = signal(false);

  protected readonly managerOptions = () =>
    this.users
      .users()
      .filter((u) => u.id !== this.editingId())
      .map((u) => ({ label: `${u.fullName} (${u.employeeId})`, value: u.id }));

  constructor() {
    this.users.refresh().subscribe({ error: (err) => this.listError.set(errorMessage(err)) });
    this.users.refreshStats().subscribe({ error: (err) => this.listError.set(errorMessage(err)) });
    this.masterData.refreshLocations().subscribe({ error: (err) => this.listError.set(errorMessage(err)) });
  }

  private initialTab(): UsersTabId {
    const tab = this.route.snapshot.queryParamMap.get('tab');
    return TABS.some((t) => t.id === tab) ? (tab as UsersTabId) : TABS[0].id;
  }

  protected selectTab(id: UsersTabId): void {
    this.activeTab.set(id);
    this.router.navigate([], { queryParams: { tab: id }, queryParamsHandling: 'merge', relativeTo: this.route });
  }

  protected onSearchInput(event: Event, table: Table): void {
    const value = (event.target as HTMLInputElement).value;
    table.filterGlobal(value, 'contains');
  }

  protected updateForm(patch: Partial<UserFormState>): void {
    this.form.update((f) => {
      const next = { ...f, ...patch };
      // An Admin sees every branch and every screen by role — clearing grants
      // here keeps the payload honest, rather than sending ones that'd be ignored.
      if (next.role === 'Admin') {
        next.locations = [];
        next.screenKeys = [];
      } else if (patch.role === 'Auditor' && f.role !== 'Auditor') {
        next.screenKeys = [...AUDITOR_DEFAULT_SCREENS];
      }
      return next;
    });
  }

  protected openAdd(): void {
    this.editingId.set(null);
    this.form.set(emptyForm());
    this.formError.set(null);
    this.dialogVisible.set(true);
  }

  protected openEdit(user: FrsUser): void {
    this.editingId.set(user.id);
    this.form.set({
      employeeId: user.employeeId,
      fullName: user.fullName,
      password: '',
      role: user.role,
      managerId: user.managerId,
      email: user.email ?? '',
      mobileNumber: user.mobileNumber ?? '',
      locations: user.locations ?? [],
      screenKeys: user.screenKeys ?? [],
    });
    this.formError.set(null);
    this.dialogVisible.set(true);
  }

  protected save(): void {
    const f = this.form();
    const editing = this.editingId();

    if (!editing) {
      if (!f.employeeId.trim()) return this.formError.set('Employee ID is required');
      if (!f.fullName.trim()) return this.formError.set('Name is required');
      if (!f.password || f.password.length < 6) return this.formError.set('Password must be at least 6 characters');
    } else if (!f.fullName.trim()) {
      return this.formError.set('Name is required');
    }
    if (!f.role) return this.formError.set('Role is required');

    this.saving.set(true);
    this.formError.set(null);

    const request = editing
      ? this.users.update(editing, {
          fullName: f.fullName.trim(),
          role: f.role,
          managerId: f.managerId,
          email: f.email.trim(),
          mobileNumber: f.mobileNumber.trim(),
        })
      : this.users.create({
          employeeId: f.employeeId.trim(),
          fullName: f.fullName.trim(),
          password: f.password,
          role: f.role,
          managerId: f.managerId,
          email: f.email.trim(),
          mobileNumber: f.mobileNumber.trim(),
          locations: f.locations,
          screenKeys: f.screenKeys,
        });

    request.subscribe({
      next: () => {
        this.saving.set(false);
        this.dialogVisible.set(false);
        this.refreshStats();
      },
      error: (err) => {
        this.saving.set(false);
        this.formError.set(errorMessage(err));
      },
    });
  }

  /** Fire-and-forget refresh of the header card row after anything that could move its numbers. */
  private refreshStats(): void {
    this.users.refreshStats().subscribe();
  }

  // ---- branches ---------------------------------------------------------------

  protected openBranches(user: FrsUser): void {
    this.branchesUser.set(user);
    this.branchesDraft.set(user.locations ?? []);
    this.branchesError.set(null);
    this.branchesSaving.set(false);
  }

  protected saveBranches(): void {
    const user = this.branchesUser();
    if (!user) return;
    this.branchesSaving.set(true);
    this.branchesError.set(null);
    this.users.setLocations(user.id, this.branchesDraft()).subscribe({
      next: () => {
        this.branchesSaving.set(false);
        this.branchesUser.set(null);
        this.refreshStats();
      },
      error: (err) => {
        this.branchesSaving.set(false);
        this.branchesError.set(errorMessage(err));
      },
    });
  }

  // ---- screen access ---------------------------------------------------------------

  /** Table cell text: an Admin has every screen by role; an Auditor shows what they were granted. */
  protected screenLabels(user: FrsUser): string[] {
    return (user.screenKeys ?? []).map((k) => SCREEN_LABELS[k] ?? k);
  }

  protected openScreens(user: FrsUser): void {
    this.screensUser.set(user);
    this.screensDraft.set(user.screenKeys ?? []);
    this.screensError.set(null);
    this.screensSaving.set(false);
  }

  protected saveScreens(): void {
    const user = this.screensUser();
    if (!user) return;
    this.screensSaving.set(true);
    this.screensError.set(null);
    this.users.setScreens(user.id, this.screensDraft()).subscribe({
      next: () => {
        this.screensSaving.set(false);
        this.screensUser.set(null);
      },
      error: (err) => {
        this.screensSaving.set(false);
        this.screensError.set(errorMessage(err));
      },
    });
  }

  // ---- status / unlock ----------------------------------------------------------

  protected isSelf(user: FrsUser): boolean {
    return this.auth.userId() === user.employeeId;
  }

  protected toggleActive(user: FrsUser): void {
    this.users.setStatus(user.id, !user.isActive).subscribe({
      next: () => this.refreshStats(),
      error: (err) => this.listError.set(errorMessage(err)),
    });
  }

  protected unlock(user: FrsUser): void {
    this.users.unlock(user.id).subscribe({
      next: () => this.refreshStats(),
      error: (err) => this.listError.set(errorMessage(err)),
    });
  }

  // ---- reset password -----------------------------------------------------------

  protected openReset(user: FrsUser): void {
    this.resetUser.set(user);
    this.resetPassword1.set('');
    this.resetPassword2.set('');
    this.resetError.set(null);
    this.resetSaving.set(false);
  }

  protected saveReset(): void {
    const user = this.resetUser();
    if (!user) return;
    if (this.resetPassword1().length < 6) return this.resetError.set('Password must be at least 6 characters');
    if (this.resetPassword1() !== this.resetPassword2()) return this.resetError.set('Passwords do not match');

    this.resetSaving.set(true);
    this.resetError.set(null);
    this.users.resetPassword(user.id, this.resetPassword1()).subscribe({
      next: () => {
        this.resetSaving.set(false);
        this.resetUser.set(null);
      },
      error: (err) => {
        this.resetSaving.set(false);
        this.resetError.set(errorMessage(err));
      },
    });
  }

  // ---- activity -------------------------------------------------------------------

  protected openActivity(user: FrsUser): void {
    this.activityUser.set(user);
    this.activityLoading.set(true);
    this.activityLog.set([]);
    this.users.auditLogs(user.id).subscribe({
      next: (entries) => {
        this.activityLoading.set(false);
        this.activityLog.set(entries);
      },
      error: () => this.activityLoading.set(false),
    });
  }
}
