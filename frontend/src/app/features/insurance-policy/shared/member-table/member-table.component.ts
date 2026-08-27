import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Table, TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { SelectModule } from 'primeng/select';
import { DialogModule } from 'primeng/dialog';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { Gender, InsuredMember, MEMBER_RELATIONS, MemberRelation, PolicyTypeSelfParents } from '../../../../core/models';

interface MemberDraft {
  name: string;
  relationWithPolicyHolder: MemberRelation;
  age: number;
  gender: Gender;
  occupation: string;
  basePremium: number;
  policyTypeSelfParents: string;
  nomineeName: string;
  nomineeRelation: string;
}

function emptyDraft(): MemberDraft {
  return {
    name: '',
    relationWithPolicyHolder: 'Self',
    age: 30,
    gender: 'Male',
    occupation: '',
    basePremium: 0,
    // 'Self' is the default relation above, so this starts as the non-parent code.
    policyTypeSelfParents: 'A',
    nomineeName: '',
    nomineeRelation: '',
  };
}

@Component({
  selector: 'app-member-table',
  standalone: true,
  imports: [
    DecimalPipe,
    FormsModule,
    TableModule,
    ButtonModule,
    InputTextModule,
    InputNumberModule,
    SelectModule,
    DialogModule,
    TagModule,
    TooltipModule,
  ],
  templateUrl: './member-table.component.html',
  styleUrl: './member-table.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'app-member-table-host' },
})
export class MemberTableComponent {
  readonly members = input.required<InsuredMember[]>();
  readonly editable = input(true);

  readonly memberAdd = output<Omit<InsuredMember, 'id'>>();
  readonly memberUpdate = output<{ id: string; patch: Partial<InsuredMember> }>();
  readonly memberRemove = output<string>();
  readonly memberDuplicate = output<string>();

  protected readonly relations = MEMBER_RELATIONS;
  protected readonly genders: Gender[] = ['Male', 'Female', 'Other'];

  protected readonly editingId = signal<string | null>(null);
  protected readonly draft = signal<MemberDraft>(emptyDraft());
  protected readonly addDialogVisible = signal(false);
  protected readonly newDraft = signal<MemberDraft>(emptyDraft());

  protected startEdit(member: InsuredMember): void {
    this.editingId.set(member.id);
    this.draft.set({
      name: member.name,
      relationWithPolicyHolder: member.relationWithPolicyHolder,
      age: member.age,
      gender: member.gender,
      occupation: member.occupation ?? '',
      basePremium: member.basePremium,
      policyTypeSelfParents: member.policyTypeSelfParents,
      nomineeName: member.nomineeName ?? '',
      nomineeRelation: member.nomineeRelation ?? '',
    });
  }

  protected cancelEdit(): void {
    this.editingId.set(null);
  }

  protected saveEdit(id: string): void {
    this.memberUpdate.emit({ id, patch: this.draft() });
    this.editingId.set(null);
  }

  protected updateDraft(patch: Partial<MemberDraft>): void {
    this.draft.update((d) => ({ ...d, ...patch }));
  }

  protected openAddDialog(): void {
    this.newDraft.set(emptyDraft());
    this.addDialogVisible.set(true);
  }

  protected updateNewDraft(patch: Partial<MemberDraft>): void {
    this.newDraft.update((d) => ({ ...d, ...patch }));
  }

  protected confirmAdd(): void {
    const d = this.newDraft();
    if (!d.name.trim()) return;
    this.memberAdd.emit({
      ...d,
      occupation: d.occupation.trim() || null,
      nomineeName: d.nomineeName.trim() || null,
      nomineeRelation: d.nomineeRelation.trim() || null,
      dateOfBirth: null,
      inceptionDate: null,
    });
    this.addDialogVisible.set(false);
  }

  protected onSearchInput(event: Event, table: Table): void {
    const value = (event.target as HTMLInputElement).value;
    table.filterGlobal(value, 'contains');
  }
}
