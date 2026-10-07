import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Table, TableModule } from 'primeng/table';
import { InputTextModule } from 'primeng/inputtext';
import { DialogModule } from 'primeng/dialog';
import { TooltipModule } from 'primeng/tooltip';
import { MasterDataService } from '../../../core/services/master-data.service';
import { errorMessage } from '../../../core/utils/error-message.util';
import { FrsLocation } from '../../../core/models';
import { PageHeaderComponent } from '../../../shared/ui/page-header.component';

/**
 * Client mail item 2, "Hospital Location Master — Addition/Deletion". The
 * API (backend/src/routes/master-data.routes.js /locations) and the service
 * methods (MasterDataService.addLocation/updateLocation/deactivateLocation)
 * already existed; this screen was the only missing piece.
 *
 * Simpler than Division & Bank A/C: a location is only a name + active flag,
 * and "deletion" is the backend's own soft-deactivate (UPDATE active =
 * false, never a real DELETE — see the route's own comment).
 *
 * 2026-09-22: the Active pill alone wasn't visibly a "delete" action to
 * sriram/the client (client mail item 2 literally asks for "Addition/
 * Deletion") — it just read as a status label. Added an explicit trash/
 * restore icon in Actions, same slot and same .modal-overlay confirm
 * pattern the bank account screen's pi-trash uses (styles/_components.scss),
 * for one consistent "delete" affordance across Master Data. The wording is
 * the one deliberate difference: that screen's confirmDelete is a real,
 * unrecoverable DELETE FROM; this stays the reversible deactivate underneath
 * (toggleActive), so the copy says so instead of implying data loss.
 */
@Component({
  selector: 'app-locations',
  standalone: true,
  imports: [FormsModule, TableModule, InputTextModule, DialogModule, TooltipModule, PageHeaderComponent],
  templateUrl: './locations.component.html',
  styleUrl: './locations.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LocationsComponent {
  protected readonly masterData = inject(MasterDataService);

  protected readonly dialogVisible = signal(false);
  protected readonly editingId = signal<string | null>(null);
  protected readonly draftName = signal('');
  /** The HIS API `loc` code, as typed — '' means not set. */
  protected readonly draftHisLocCode = signal('');
  protected readonly formError = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly listError = signal<string | null>(null);
  protected readonly pendingDeactivate = signal<FrsLocation | null>(null);
  protected readonly deactivating = signal(false);

  constructor() {
    this.masterData.refreshLocations().subscribe({ error: (err) => this.listError.set(errorMessage(err)) });
  }

  protected onSearchInput(event: Event, table: Table): void {
    const value = (event.target as HTMLInputElement).value;
    table.filterGlobal(value, 'contains');
  }

  protected openAdd(): void {
    this.editingId.set(null);
    this.draftName.set('');
    this.draftHisLocCode.set('');
    this.formError.set(null);
    this.dialogVisible.set(true);
  }

  protected openEdit(location: FrsLocation): void {
    this.editingId.set(location.id);
    this.draftName.set(location.name);
    this.draftHisLocCode.set(location.hisLocCode === null || location.hisLocCode === undefined ? '' : String(location.hisLocCode));
    this.formError.set(null);
    this.dialogVisible.set(true);
  }

  protected save(): void {
    const name = this.draftName().trim();
    if (!name) return this.formError.set('Name is required');
    const codeText = String(this.draftHisLocCode() ?? '').trim();
    if (codeText && !/^\d+$/.test(codeText)) return this.formError.set('HIS Loc Code must be a whole number');
    const hisLocCode = codeText ? Number(codeText) : null;

    this.saving.set(true);
    this.formError.set(null);

    const editingId = this.editingId();
    const request = editingId
      ? this.masterData.updateLocation(editingId, { name, hisLocCode })
      : this.masterData.addLocation(name, hisLocCode);

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

  /** Reactivating needs no confirm — it only widens access back to where it was. */
  protected reactivate(location: FrsLocation): void {
    this.masterData.updateLocation(location.id, { active: true }).subscribe({
      error: (err) => this.listError.set(errorMessage(err)),
    });
  }

  /** Deactivating ("Deletion" per client mail item 2) does, via the trash icon — see requestDeactivate. */
  protected requestDeactivate(location: FrsLocation): void {
    this.pendingDeactivate.set(location);
  }

  protected cancelDeactivate(): void {
    this.pendingDeactivate.set(null);
  }

  protected confirmDeactivate(): void {
    const location = this.pendingDeactivate();
    if (!location || this.deactivating()) return;
    this.deactivating.set(true);
    this.masterData.deactivateLocation(location.id).subscribe({
      next: () => {
        this.deactivating.set(false);
        this.pendingDeactivate.set(null);
      },
      error: (err) => {
        this.deactivating.set(false);
        this.pendingDeactivate.set(null);
        this.listError.set(errorMessage(err));
      },
    });
  }
}
