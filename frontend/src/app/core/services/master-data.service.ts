import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';
import { DivisionBankAccount, DivisionBankAccountDraft, FrsLocation } from '../models';
import { API_BASE_URL } from '../config/api.config';

@Injectable({ providedIn: 'root' })
export class MasterDataService {
  private readonly http = inject(HttpClient);

  private readonly _accounts = signal<DivisionBankAccount[]>([]);
  readonly accounts = this._accounts.asReadonly();

  private readonly _loading = signal(false);
  readonly loading = this._loading.asReadonly();

  private readonly _locations = signal<FrsLocation[]>([]);
  readonly locations = this._locations.asReadonly();
  /** Names only, active branches — what a location picker actually offers. */
  readonly activeLocationNames = () => this._locations().filter((l) => l.active).map((l) => l.name);

  /** GET /api/master/division-bank-accounts */
  refresh(): Observable<DivisionBankAccount[]> {
    this._loading.set(true);
    return this.http.get<DivisionBankAccount[]>(`${API_BASE_URL}/master/division-bank-accounts`).pipe(
      tap((accounts) => {
        this._accounts.set(accounts);
        this._loading.set(false);
      }),
    );
  }

  /** POST /api/master/division-bank-accounts */
  add(draft: DivisionBankAccountDraft): Observable<DivisionBankAccount> {
    return this.http
      .post<DivisionBankAccount>(`${API_BASE_URL}/master/division-bank-accounts`, draft)
      .pipe(tap((created) => this._accounts.update((accounts) => [...accounts, created])));
  }

  /** PATCH /api/master/division-bank-accounts/:id — also used for the list view's quick active-toggle. */
  update(id: string, patch: Partial<DivisionBankAccountDraft>): Observable<DivisionBankAccount> {
    return this.http.patch<DivisionBankAccount>(`${API_BASE_URL}/master/division-bank-accounts/${id}`, patch).pipe(
      tap((updated) => this._accounts.update((accounts) => accounts.map((a) => (a.id === id ? updated : a)))),
    );
  }

  /** DELETE /api/master/division-bank-accounts/:id */
  remove(id: string): Observable<void> {
    return this.http.delete<void>(`${API_BASE_URL}/master/division-bank-accounts/${id}`).pipe(
      tap(() => this._accounts.update((accounts) => accounts.filter((a) => a.id !== id))),
    );
  }

  // -------------------------------------------------------------------------
  // Locations (branches) — AC-2. Simple list-and-toggle, no dialog: the
  // Users screen's branch picker is the actual day-to-day surface for this;
  // this is just where the master list itself is maintained.
  // -------------------------------------------------------------------------

  /** GET /api/master/locations */
  refreshLocations(): Observable<FrsLocation[]> {
    return this.http.get<FrsLocation[]>(`${API_BASE_URL}/master/locations`).pipe(
      tap((locations) => this._locations.set(locations)),
    );
  }

  /** POST /api/master/locations */
  addLocation(name: string): Observable<FrsLocation> {
    return this.http
      .post<FrsLocation>(`${API_BASE_URL}/master/locations`, { name })
      .pipe(tap((created) => this._locations.update((locs) => [...locs, created])));
  }

  /** PATCH /api/master/locations/:id */
  updateLocation(id: string, patch: { name?: string; active?: boolean }): Observable<FrsLocation> {
    return this.http.patch<FrsLocation>(`${API_BASE_URL}/master/locations/${id}`, patch).pipe(
      tap((updated) => this._locations.update((locs) => locs.map((l) => (l.id === id ? updated : l)))),
    );
  }

  /** DELETE /api/master/locations/:id — deactivates, does not remove (see route comment). */
  deactivateLocation(id: string): Observable<FrsLocation> {
    return this.http.delete<FrsLocation>(`${API_BASE_URL}/master/locations/${id}`).pipe(
      tap((updated) => this._locations.update((locs) => locs.map((l) => (l.id === id ? updated : l)))),
    );
  }
}
