import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Table, TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { DialogModule } from 'primeng/dialog';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { TooltipModule } from 'primeng/tooltip';
import { MasterDataService } from '../../../core/services/master-data.service';
import { errorMessage } from '../../../core/services/policy-document.service';
import { DIVISIONS, Division, DivisionBankAccount, DivisionBankAccountDraft } from '../../../core/models';

function emptyDraft(): DivisionBankAccountDraft {
  return { divisionName: null, accountNumber: '', bankName: '', active: true };
}

@Component({
  selector: 'app-division-bank-accounts',
  standalone: true,
  imports: [
    FormsModule,
    TableModule,
    ButtonModule,
    InputTextModule,
    SelectModule,
    DialogModule,
    ToggleSwitchModule,
    TooltipModule,
  ],
  templateUrl: './division-bank-accounts.component.html',
  styleUrl: './division-bank-accounts.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DivisionBankAccountsComponent {
  protected readonly masterData = inject(MasterDataService);

  protected readonly divisions: Division[] = [...DIVISIONS];

  protected readonly dialogVisible = signal(false);
  protected readonly editingId = signal<string | null>(null);
  protected readonly draft = signal<DivisionBankAccountDraft>(emptyDraft());
  protected readonly formError = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly listError = signal<string | null>(null);

  constructor() {
    this.masterData.refresh().subscribe({ error: (err) => this.listError.set(errorMessage(err)) });
  }

  protected onSearchInput(event: Event, table: Table): void {
    const value = (event.target as HTMLInputElement).value;
    table.filterGlobal(value, 'contains');
  }

  protected updateDraft(patch: Partial<DivisionBankAccountDraft>): void {
    this.draft.update((d) => ({ ...d, ...patch }));
  }

  protected openAdd(): void {
    this.editingId.set(null);
    this.draft.set(emptyDraft());
    this.formError.set(null);
    this.dialogVisible.set(true);
  }

  protected openEdit(account: DivisionBankAccount): void {
    this.editingId.set(account.id);
    this.draft.set({
      divisionName: account.divisionName,
      accountNumber: account.accountNumber,
      bankName: account.bankName,
      active: account.active,
    });
    this.formError.set(null);
    this.dialogVisible.set(true);
  }

  protected save(): void {
    const d = this.draft();
    if (!d.divisionName) return this.formError.set('Division is required');
    if (!d.accountNumber.trim()) return this.formError.set('Account Number is required');
    if (!d.bankName.trim()) return this.formError.set('Bank Name is required');

    this.saving.set(true);
    this.formError.set(null);

    const payload = { ...d, accountNumber: d.accountNumber.trim(), bankName: d.bankName.trim() };
    const request = this.editingId()
      ? this.masterData.update(this.editingId()!, payload)
      : this.masterData.add(payload);

    request.subscribe({
      next: () => {
        this.saving.set(false);
        this.dialogVisible.set(false);
      },
      error: (err) => {
        this.saving.set(false);
        this.formError.set(errorMessage(err));
      },
    });
  }

  protected toggleActive(account: DivisionBankAccount): void {
    this.masterData.update(account.id, { active: !account.active }).subscribe({
      error: (err) => this.listError.set(errorMessage(err)),
    });
  }

  protected deleteAccount(id: string): void {
    this.masterData.remove(id).subscribe({ error: (err) => this.listError.set(errorMessage(err)) });
  }
}
