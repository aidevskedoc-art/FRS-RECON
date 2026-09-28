import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { API_BASE_URL } from '../config/api.config';

interface ScanStatus {
  running: boolean;
  startedAt: string | null;
}

const IDLE_POLL_MS = 30_000;
const RUNNING_POLL_MS = 5_000;

/**
 * Whether the shared-folder scan is running right now. While it is, the
 * backend pauses uploads, deletes and Generate (folder-watch/scan-lock.js), and
 * the shell shows a banner so nobody is surprised by the refusal.
 *
 * Polled slowly when idle, quickly while running so the banner clears soon
 * after the scan ends; `refreshNow()` lets the auth interceptor update it the
 * moment a request comes back paused.
 */
@Injectable({ providedIn: 'root' })
export class ScanStatusService {
  private readonly http = inject(HttpClient);
  private readonly _running = signal(false);
  private readonly _startedAt = signal<string | null>(null);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private polling = false;

  readonly running = this._running.asReadonly();
  readonly startedAt = this._startedAt.asReadonly();

  start(): void {
    if (this.polling) return;
    this.polling = true;
    this.refreshNow();
  }

  stop(): void {
    this.polling = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  refreshNow(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.http.get<ScanStatus>(`${API_BASE_URL}/scan-status`).subscribe({
      next: (s) => {
        this._running.set(!!s.running);
        this._startedAt.set(s.startedAt);
        this.schedule();
      },
      // Backend unreachable or signed out: no banner; the next poll tries again.
      error: () => {
        this._running.set(false);
        this.schedule();
      },
    });
  }

  private schedule(): void {
    if (!this.polling) return;
    this.timer = setTimeout(() => this.refreshNow(), this._running() ? RUNNING_POLL_MS : IDLE_POLL_MS);
  }
}
