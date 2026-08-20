import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';
import { DivisionBankAccount, DivisionBankAccountDraft } from '../models';
import { API_BASE_URL } from '../config/api.config';

@Injectable({ providedIn: 'root' })
export class MasterDataService {
  private readonly http = inject(HttpClient);

  private readonly _accounts = signal<DivisionBankAccount[]>([]);
  readonly accounts = this._accounts.asReadonly();

  private readonly _loading = signal(false);
  readonly loading = this._loading.asReadonly();

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
}
