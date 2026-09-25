import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { DatePipe, formatDate } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Observable } from 'rxjs';
import { TableLazyLoadEvent, TableModule } from 'primeng/table';
import { InputTextModule } from 'primeng/inputtext';
import { DialogModule } from 'primeng/dialog';
import { DatePickerModule } from 'primeng/datepicker';
import { SelectModule } from 'primeng/select';
import { MultiSelectModule } from 'primeng/multiselect';
import { MismatchReviewService } from '../../core/services/mismatch-review.service';
import { MasterDataService } from '../../core/services/master-data.service';
import { ChequeCollectionService } from '../../core/services/cheque-collection.service';
import { UcrMatchedService } from '../../core/services/ucr-matched.service';
import { MatchApprovalService } from '../../core/services/match-approval.service';
import { AuthService } from '../../core/services/auth.service';
import { errorMessage } from '../../core/services/policy-document.service';
import {
  AppliedMatch,
  ApprovalEntityType,
  ChequeCollectionRecord,
  DEPARTMENT_LABELS,
  Department,
  MISMATCH_STATUSES,
  MatchStatusFilter,
  STATUS_FILTER_OPTIONS,
  STATUS_LABELS,
  statusesForTab,
  OnlineMismatchRecord,
  PendingChange,
  ReconciliationDates,
  UCR_MISMATCH_STATUSES,
  UcrIpRecord,
} from '../../core/models';
import { PageHeaderComponent } from '../../shared/ui/page-header.component';
import { RecordDetailComponent, RecordDetailView } from './record-detail/record-detail.component';

type TabId = 'online' | 'cheque' | 'card' | 'upi';

interface ReviewTab {
  readonly id: TabId;
  readonly label: string;
  readonly icon: string;
}

const TABS: readonly ReviewTab[] = [
  { id: 'online', label: 'Online (IP + Diag/OP)', icon: 'pi pi-globe' },
  { id: 'cheque', label: 'Cheque', icon: 'pi pi-file' },
  { id: 'card', label: 'Card', icon: 'pi pi-credit-card' },
  { id: 'upi', label: 'UPI', icon: 'pi pi-mobile' },
];

/** Short noun phrase per tab, for embedding in the dynamic subtitle sentence (headerSubtitle) — TABS.label reads fine as a tab caption but not mid-sentence. */
const TAB_NOUN: Record<TabId, string> = {
  online: 'online IP and Diagnostics/OP',
  cheque: 'cheque collection',
  card: 'card',
  upi: 'UPI',
};

/**
 * The three Excel downloads the client asked for. Each is one workbook covering
 * all four tabs; the toolbar's other filters narrow whichever is chosen.
 *
 * Separate buttons rather than "export what is on screen": they asked to pull a
 * Matched report without first switching the screen to Matched, which is a
 * reasonable thing to want when the screen is a review worklist.
 */
type ExportReport = 'mismatches' | 'matched' | 'all' | 'matched_by_auditor';
const EXPORT_REPORTS: readonly { mode: ExportReport; label: string; hint: string }[] = [
  { mode: 'mismatches', label: 'Mismatched', hint: 'Everything short of a clean match, all four tabs, in one file' },
  { mode: 'matched', label: 'Matched', hint: 'Every clean match, all four tabs, in one file' },
  { mode: 'all', label: 'All Report', hint: 'Matched and mismatched together, all four tabs, in one file' },
];

const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 300;

// AC-16 — the client's colour code (mirrors backend src/reconciliation/status-tone.js,
// which the same-named comment there says serves both "on screen" and "in the result file").
// This screen only ever lists mismatches, so GREEN never actually appears here — it's kept
// so the rule stays identical to the export's, and the legend can still explain it.
const CLEAN_MATCH_STATUSES = new Set(['MATCHED', 'GROUPED_MATCHED', 'EASEBUZZ_MATCHED', 'CONTRA_ENTRY']);
type StatusTone = 'GREEN' | 'RED' | 'ORANGE';

function statusTone(status: string | null, matchedByAuditor: boolean): StatusTone | null {
  if (!status) return null;
  if (matchedByAuditor) return 'ORANGE';
  return CLEAN_MATCH_STATUSES.has(status) ? 'GREEN' : 'RED';
}

/**
 * Client mail item 15 — a "Matched" view alongside the default mismatches
 * one, so an Auditor can find a locked system match to flag as wrong (see
 * MatchApprovalService.propose, which now also accepts a clean-match row as
 * a correction). Card/UPI's clean statuses are 'MATCHED' and 'GROUPED_MATCHED'
 * (a split payment — see card-matcher.js/upi-matcher.js; no EASEBUZZ_MATCHED/
 * CONTRA_ENTRY concept there — see UcrMatchStatus), both already members of
 * CLEAN_MATCH_STATUSES above.
 *
 * 'Matched by Auditor' is a narrower look into 'Matched' (every clean match,
 * whether green/system or orange/auditor-locked per the AC-16 legend) rather
 * than a disjoint slice of it — 'All' drops the status filter entirely.
 */
type ViewMode = 'all' | 'mismatches' | 'matched' | 'matched_by_auditor';
const UCR_CLEAN_STATUSES = ['MATCHED', 'GROUPED_MATCHED'];

interface ViewModeOption {
  readonly id: ViewMode;
  readonly label: string;
  readonly icon: string;
}

const VIEW_MODES: readonly ViewModeOption[] = [
  { id: 'all', label: 'All', icon: 'pi pi-list' },
  { id: 'mismatches', label: 'Mismatches', icon: 'pi pi-exclamation-triangle' },
  { id: 'matched', label: 'Matched', icon: 'pi pi-check-circle' },
  { id: 'matched_by_auditor', label: 'Matched by Auditor', icon: 'pi pi-shield' },
];

const VIEW_MODE_COUNT_LABEL: Record<ViewMode, string> = {
  all: 'Total Transactions',
  mismatches: 'Mismatch Transactions',
  matched: 'Matched Transactions',
  matched_by_auditor: 'Matched by Auditor',
};

const VIEW_MODE_COUNT_ICON: Record<ViewMode, string> = {
  all: 'pi pi-list',
  mismatches: 'pi pi-exclamation-circle',
  matched: 'pi pi-check-circle',
  matched_by_auditor: 'pi pi-shield',
};

const VIEW_MODE_EMPTY: Record<Exclude<ViewMode, 'mismatches'>, { title: string; hint: string }> = {
  all: { title: 'Nothing here', hint: 'No transactions in this range.' },
  matched: { title: 'No matches yet', hint: 'Nothing is a clean system match yet in this range.' },
  matched_by_auditor: { title: 'No auditor matches', hint: 'No auditor-approved matches in this range.' },
};

/** Badge colour per view, matching the AC-16 legend (green/red/orange) — 'All' is neutral, it has no verdict of its own. */
const VIEW_MODE_TONE: Record<ViewMode, 'neutral' | 'red' | 'green' | 'orange'> = {
  all: 'neutral',
  mismatches: 'red',
  matched: 'green',
  matched_by_auditor: 'orange',
};

function amountText(value: number | null | undefined): string {
  return value === null || value === undefined
    ? '—'
    : `₹${Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function toDateOnly(d: Date | null): string | undefined {
  if (!d) return undefined;
  // Local calendar date, not UTC (see frs-date-timezone-trap).
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'YYYY-MM-DD' -> '15 Sep 2026', by string — never through a Date, which can land a day early (frs-date-timezone-trap). */
function calendarDateText(ymd: string | null): string | null {
  const m = ymd ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd) : null;
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : null;
}

/**
 * AC-12 — how far the list runs. BANK (the client's default): each row only up
 * to the date its bank file reaches, since anything later can't have been
 * matched yet. AS_ON: up to a date the auditor picks.
 */
type UpTo = 'BANK' | 'AS_ON';

interface Filters {
  search: string;
  dateFrom: Date | null;
  upTo: UpTo;
  /** Only read when upTo is AS_ON; null there = no upper bound. */
  asOn: Date | null;
  /** One location name; null = All Locations (for an Auditor: all of their branches). */
  location: string | null;
  /** null = All Departments. */
  department: Department | null;
  /**
   * Exact verdicts to show; [] = whatever the view mode says.
   *
   * Narrower than the view mode, and takes precedence over it: "Mismatches" is
   * four statuses at once, and the client asked to be able to pull just one —
   * every Unmatched row, say — both on screen and into the Excel download.
   */
  statuses: MatchStatusFilter[];
}

function emptyFilters(): Filters {
  return { search: '', dateFrom: null, upTo: 'BANK', asOn: null, location: null, department: null, statuses: [] };
}

const UP_TO_OPTIONS: { label: string; value: UpTo }[] = [
  { label: 'Till last bank upload', value: 'BANK' },
  // Reads as the upper end of a From-To range, which is what it always was:
  // dateFrom + this are sent as dateFrom/dateTo. It was labelled "As on date",
  // so nobody looking for a date range found it.
  { label: 'To date', value: 'AS_ON' },
];

/** A picked Date -> '20 Sep 2026' (it's already a local calendar date, so no timezone shift). */
function pickedDateText(d: Date): string {
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

interface SelectOption<T> {
  readonly label: string;
  readonly value: T | null;
}

// AC-10: which departments each collection type actually has data for, so a
// dropdown never offers a choice that can only ever come back empty. No
// doctor-fee (OPD) cheque ledger is ingested, and the Diagnostics card/UPI
// report carries card rows only.
const DEPARTMENTS_BY_TAB: Record<TabId, readonly Department[]> = {
  online: ['IP', 'DIAG', 'OPD'],
  cheque: ['IP', 'DIAG'],
  card: ['IP', 'DIAG', 'OPD'],
  upi: ['IP', 'OPD'],
};

/** Card/UPI rows name their department by source report; OP is the doctor-fee (OPD) register. */
const UCR_SOURCE_DEPARTMENT: Record<string, Department> = { IP: 'IP', OP: 'OPD', DIAG: 'DIAG' };

function onlineDepartment(row: OnlineMismatchRecord): string {
  // Null only on a legacy (non-HIS) Diag/OP upload, which can't tell the two apart.
  return row.department ? DEPARTMENT_LABELS[row.department] : 'Diag/OP';
}

function chequeDepartment(row: ChequeCollectionRecord): string {
  // collection_kind 'OP' is the diagnostics cheque ledger.
  return row.collectionKind === 'OP' ? 'Diagnostics' : 'IP';
}

function ucrDepartment(row: UcrIpRecord): string {
  return DEPARTMENT_LABELS[UCR_SOURCE_DEPARTMENT[row.misSource ?? 'IP']];
}

function locationOf(row: { division?: string | null; unitName?: string | null }): string | null {
  return row.division || row.unitName || null;
}

// ---- record dialog field formatting ---------------------------------------------------

/** One part of a payment split — a zero there is "not paid this way", shown as empty. */
function splitAmount(value: number | null | undefined): string | null {
  return value ? amountText(value) : null;
}

function dateText(value: string | null | undefined): string | null {
  return value ? formatDate(value, 'd MMM y', 'en-US') : null;
}

function collectedBy(row: { userName: string | null; userId: string | null }): string | null {
  return [row.userName, row.userId].filter(Boolean).join(' / ') || null;
}

// ---- Matched by Auditor columns (client ask, 2026-09-22) ---------------------------
// AuditDetail is only populated once a maker-checker request has been
// APPROVED (backend src/pending-change.js's auditDetailColumn) — null on
// every other row, so these read '—' outside the Matched by Auditor view.

function personLabel(name: string | null | undefined, employeeId: string | null | undefined): string | null {
  if (!name) return null;
  return employeeId ? `${name} (${employeeId})` : name;
}

/** "Auditor details" — who flagged the change, i.e. the maker who proposed it. */
function auditorLabel(detail: { requestedByName: string | null; requestedByEmployeeId: string | null } | null | undefined): string | null {
  return detail ? personLabel(detail.requestedByName, detail.requestedByEmployeeId) : null;
}

/** "Whom Edited" — who actually approved it (their Reporting Manager, an Admin, or an Admin deciding directly). */
function modifiedByLabel(detail: { reviewedByName: string | null; reviewedByEmployeeId: string | null } | null | undefined): string | null {
  return detail ? personLabel(detail.reviewedByName, detail.reviewedByEmployeeId) : null;
}

/** "Time of Modified" — with date, per the client ask. */
function modifiedOnText(detail: { reviewedAt: string | null } | null | undefined): string | null {
  return detail?.reviewedAt ? formatDate(detail.reviewedAt, 'd MMM y, h:mm a', 'en-US') : null;
}

const GATEWAY_LABELS: Record<string, string> = { CARD_MPR: 'Card MPR', CARD_PINELABS: 'Pine Labs', UPI_MPR: 'UPI MPR' };

// ---- AC-11: every MIS field, per collection type ------------------------------------
//
// The client asked for the mismatched transactions with "all fields as per MIS
// Report along with the reason". The MIS columns and their order follow the
// Audit Working Report the client already signed off (backend
// src/excel/audit-report.js ONLINE/DIAG/CHEQUE/UCR sheets), minus its bank-side
// realisation block — that is the bank's data, not the MIS report's. Receipt
// Number is pinned left and Status + Reason pinned right, so the reason stays
// in view while the MIS fields scroll sideways.

type ReviewRow = OnlineMismatchRecord | ChequeCollectionRecord | UcrIpRecord;

/** A row's maker-checker entity type — what match-approvals.routes.js calls it. */
function rowEntityType(tab: TabId, row: ReviewRow): ApprovalEntityType {
  switch (tab) {
    case 'online': return (row as OnlineMismatchRecord).recordType;
    case 'cheque': return 'CHEQUE';
    case 'card': return 'CARD';
    case 'upi': return 'UPI';
  }
}

/** A row's own receipt number, for a bulk-action failure list — Online/Cheque call it receiptNumber, UCR calls it receiptNo. */
function rowReceiptLabel(row: ReviewRow): string {
  const receipt = 'receiptNumber' in row ? row.receiptNumber : row.receiptNo;
  return receipt || row.id;
}
type CellValue = string | number | null | undefined;
type ColumnKind = 'text' | 'ref' | 'date' | 'amount' | 'chip' | 'status' | 'reason';

interface ReviewColumn {
  readonly header: string;
  readonly kind: ColumnKind;
  readonly value: (row: ReviewRow) => CellValue;
  readonly pin?: 'left' | 'right';
}

/** Typed per collection type where it's defined; the table only ever calls it with that tab's own rows. */
function column<T extends ReviewRow>(header: string, kind: ColumnKind, value: (row: T) => CellValue, pin?: 'left' | 'right'): ReviewColumn {
  return { header, kind, value: value as (row: ReviewRow) => CellValue, pin };
}

function verdictColumns<T extends ReviewRow>(): ReviewColumn[] {
  return [
    column<T>('Status', 'status', (r) => r.matchStatus, 'right'),
    column<T>('Reason for Mismatch', 'reason', (r) => r.matchReason, 'right'),
  ];
}

/** Client ask, 2026-09-22 — "Whom Edited", "Time of Modified", "Auditor details" on the Matched by Auditor view. */
function auditColumns<T extends ReviewRow>(): ReviewColumn[] {
  return [
    column<T>('Auditor', 'text', (r) => auditorLabel(r.auditDetail)),
    column<T>('Edited By', 'text', (r) => modifiedByLabel(r.auditDetail)),
    column<T>('Time of Modified', 'text', (r) => modifiedOnText(r.auditDetail)),
  ];
}

type O = OnlineMismatchRecord;
type C = ChequeCollectionRecord;
type U = UcrIpRecord;

const ONLINE_COLUMNS: ReviewColumn[] = [
  column<O>('Receipt Number', 'ref', (r) => r.receiptNumber, 'left'),
  column<O>('Receipt Date', 'date', (r) => r.receiptDate),
  column<O>('IP / OP / Diag', 'chip', onlineDepartment),
  column<O>('Location', 'text', locationOf),
  column<O>('YH No', 'ref', (r) => r.yhno),
  column<O>('IP / Diag No', 'ref', (r) => r.unitNo),
  column<O>('Patient Name', 'text', (r) => r.patientName),
  column<O>('Transaction Ref 1', 'ref', (r) => r.transactionRef1),
  column<O>('Transaction Ref 2', 'ref', (r) => r.transactionRef2),
  column<O>('Trans ID', 'ref', (r) => r.transId),
  column<O>('Online Payment Mode', 'text', (r) => r.paymentMode),
  column<O>('Pat Type', 'text', (r) => r.patType),
  column<O>('Pay Type', 'text', (r) => r.payType),
  column<O>('Online Amount', 'amount', (r) => r.onlineUpiAmount),
  column<O>('Bill Amount', 'amount', (r) => r.billAmount),
  column<O>('Cash Amount', 'amount', (r) => r.cashAmount),
  column<O>('Card Amount', 'amount', (r) => r.cardAmount),
  column<O>('Cheque Amount', 'amount', (r) => r.chequeAmount),
  column<O>('Discount Amount', 'amount', (r) => r.discountAmount),
  column<O>('Diff Amount', 'amount', (r) => r.diffAmount),
  column<O>('MIS Remarks', 'text', (r) => r.remarks),
  column<O>('Payment Remarks', 'text', (r) => r.paymentRemarks),
  column<O>('User ID', 'ref', (r) => r.userId),
  column<O>('User Name', 'text', (r) => r.userName),
  ...auditColumns<O>(),
  ...verdictColumns<O>(),
];

const CHEQUE_COLUMNS: ReviewColumn[] = [
  column<C>('Receipt Number', 'ref', (r) => r.receiptNumber, 'left'),
  column<C>('Receipt Date', 'date', (r) => r.receiptDate),
  column<C>('IP / Diag', 'chip', chequeDepartment),
  column<C>('Location', 'text', locationOf),
  column<C>('IP / Diagnostics No', 'ref', (r) => r.ipNo ?? r.diagNo),
  column<C>('YH No', 'ref', (r) => r.yhno),
  column<C>('Name of the Patient', 'text', (r) => r.patientName),
  column<C>('Cheque No', 'ref', (r) => r.chequeNo),
  column<C>('Cheque Date', 'date', (r) => r.chequeDate),
  column<C>('Patient Type', 'text', (r) => r.payType ?? r.patType),
  column<C>('Drawee Bank', 'text', (r) => r.bankName),
  column<C>('Drawee Branch', 'text', (r) => r.branchName),
  column<C>('Cheque Amount', 'amount', (r) => r.chequeAmount),
  column<C>('Receipt Amount', 'amount', (r) => r.receiptAmount),
  column<C>('Bill Amount', 'amount', (r) => r.billAmount),
  column<C>('User ID', 'ref', (r) => r.userId),
  column<C>('User Name', 'text', (r) => r.userName),
  ...auditColumns<C>(),
  ...verdictColumns<C>(),
];

const UCR_COLUMNS: ReviewColumn[] = [
  column<U>('Receipt Number', 'ref', (r) => r.receiptNo, 'left'),
  column<U>('Receipt Date', 'date', (r) => r.receiptDate),
  column<U>('IP / OP / Diag', 'chip', ucrDepartment),
  column<U>('Location', 'text', locationOf),
  column<U>('YH No', 'ref', (r) => r.yhNo),
  column<U>('IP / Diag No', 'ref', (r) => r.ipNo ?? r.diagNo),
  column<U>('Patient Name', 'text', (r) => r.patientName),
  column<U>('Bill No', 'ref', (r) => r.billNo),
  column<U>('Instrument Type', 'text', (r) => r.instrumentType),
  column<U>('Reference ID', 'ref', (r) => r.referenceId),
  column<U>('Amount', 'amount', (r) => r.amount),
  // Group figures: a split payment's receipts share one reference and are judged on their sum.
  column<U>('Group Amount', 'amount', (r) => r.matchGroupAmount),
  column<U>('Difference', 'amount', (r) => r.matchDifference),
  column<U>('User ID', 'ref', (r) => r.userId),
  column<U>('User Name', 'text', (r) => r.userName),
  ...auditColumns<U>(),
  ...verdictColumns<U>(),
];

const COLUMNS_BY_TAB: Record<TabId, ReviewColumn[]> = {
  online: ONLINE_COLUMNS,
  cheque: CHEQUE_COLUMNS,
  card: UCR_COLUMNS,
  upi: UCR_COLUMNS,
};

const EMPTY_HINT: Record<TabId, string> = {
  online: 'Everything in this range is cleanly matched.',
  cheque: 'Everything in this range is cleanly matched.',
  card: "Everything is cleanly matched — or Card Reconciliation hasn't been generated yet.",
  upi: "Everything is cleanly matched — or UPI Reconciliation hasn't been generated yet.",
};

interface TabState {
  readonly rows: ReviewRow[];
  /** Null until this tab's count has been fetched once. */
  readonly total: number | null;
  readonly page: number;
}

interface ListPage {
  readonly records: ReviewRow[];
  readonly total: number;
}

function emptyTabs(): Record<TabId, TabState> {
  const blank: TabState = { rows: [], total: null, page: 1 };
  return { online: blank, cheque: blank, card: blank, upi: blank };
}

/**
 * Mismatch Review — the client mail's "Collection and Bank Deposit
 * Reconciliation" screen (point 1 of the audit-control ask). That name turned
 * out to be the whole application's (core/config/app-name.ts), so the page
 * itself goes by what its sidebar entry already said. A tab per collection
 * type (Online/Cheque/Card/UPI, matching the client's own S.No 1-4 list),
 * each defaulting to mismatched-only (everything short of a clean match —
 * see MISMATCH_STATUSES). Clicking a row opens the full record plus its
 * plain-English mismatch reason — every record type already carries a
 * client-facing reason string (see backend/src/routes/matched-rules.routes.js
 * diagnoseUnmatched() and friends), so no extra fetch is needed: the already-
 * loaded row IS the detail.
 *
 * AC-9 (logged-in user + reporting manager) lives in the topbar, on every
 * screen — see layout/topbar.
 *
 * AC-10 Location + Department filters. A row's location is its upload
 * batch's HIS report header, matched to the location master server-side
 * (backend src/scope-filters.js). An Auditor only ever sees the branches an
 * Admin granted them: their dropdown lists just those, and "All Locations"
 * sends exactly that list. Admins get every active location, and "All" sends
 * nothing — so it also includes rows whose unit couldn't be resolved.
 *
 * AC-11 — three cards above the table: when the tab's MIS data and bank (or
 * MPR) file were last uploaded and how far each runs, and the mismatch count;
 * each tab also carries its own count. The table shows every MIS field (see
 * COLUMNS_BY_TAB) with the reason.
 *
 * AC-12 — by default the list stops where the bank data does ("till last bank
 * upload"), each branch at its own statement's date (the server does the
 * per-branch cut, backend src/scope-filters.js); or "as on" a picked date.
 * cutoffNote says which date(s) applied.
 */
@Component({
  selector: 'app-mismatch-review',
  standalone: true,
  imports: [DatePipe, FormsModule, TableModule, InputTextModule, DialogModule, DatePickerModule, SelectModule, MultiSelectModule, PageHeaderComponent, RecordDetailComponent],
  templateUrl: './mismatch-review.component.html',
  styleUrl: './mismatch-review.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MismatchReviewComponent {
  private readonly mismatchReview = inject(MismatchReviewService);
  private readonly chequeCollections = inject(ChequeCollectionService);
  private readonly ucrMatched = inject(UcrMatchedService);
  private readonly matchApproval = inject(MatchApprovalService);
  private readonly masterData = inject(MasterDataService);
  protected readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly tabs = TABS;
  protected readonly viewModes = VIEW_MODES;
  protected readonly pageSize = PAGE_SIZE;
  protected readonly activeTab = signal<TabId>(this.initialTab());
  protected readonly viewMode = signal<ViewMode>(this.initialViewMode());
  protected readonly filters = signal<Filters>(emptyFilters());
  protected readonly listError = signal<string | null>(null);
  protected readonly loading = signal(false);
  /** Which report is downloading, so only that button spins. null = idle. */
  protected readonly exporting = signal<ExportReport | null>(null);
  protected readonly exportError = signal<string | null>(null);
  protected readonly exportReports = EXPORT_REPORTS;

  // ---- list state, one entry per tab ---------------------------------------------------
  private readonly tabState = signal<Record<TabId, TabState>>(emptyTabs());
  protected readonly columns = computed(() => COLUMNS_BY_TAB[this.activeTab()]);
  protected readonly activeRows = computed(() => this.tabState()[this.activeTab()].rows);
  protected readonly activePage = computed(() => this.tabState()[this.activeTab()].page);
  /** Row count for whichever tab is showing — the "Mismatch Transactions" card and toolbar. */
  protected readonly activeTotal = computed(() => this.tabState()[this.activeTab()].total ?? 0);
  protected readonly viewModeCountLabel = computed(() => VIEW_MODE_COUNT_LABEL[this.viewMode()]);
  protected readonly viewModeCountIcon = computed(() => VIEW_MODE_COUNT_ICON[this.viewMode()]);
  protected readonly emptyState = computed<{ title: string; hint: string }>(() => {
    const mode = this.viewMode();
    return mode === 'mismatches' ? { title: 'No mismatches', hint: EMPTY_HINT[this.activeTab()] } : VIEW_MODE_EMPTY[mode];
  });
  // ---- top-of-page breakdown: every view's count against the active tab's total ----
  private readonly viewModeCounts = signal<Record<ViewMode, number | null>>({
    all: null, mismatches: null, matched: null, matched_by_auditor: null,
  });

  // ---- top-of-page highlight: every collection type's own grand total, regardless of tab/view open ----
  private readonly tabTotals = signal<Record<TabId, number | null>>({ online: null, cheque: null, card: null, upi: null });

  // Stale-response guards: only the latest request of each kind may write.
  private listSeq = 0;
  private countSeq = 0;
  private viewModeCountSeq = 0;
  private tabTotalsSeq = 0;
  private datesSeq = 0;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  // ---- AC-11 file freshness ----------------------------------------------------------
  private readonly dates = signal<ReconciliationDates | null>(null);
  protected readonly activeDates = computed(() => this.dates()?.[this.activeTab()] ?? null);
  protected readonly activeTabLabel = computed(() => TABS.find((t) => t.id === this.activeTab())?.label ?? '');

  /**
   * Client ask, 2026-09-23: the page heading always read "Mismatch Review",
   * even on the Matched / Matched by Auditor / All views where that name is
   * simply wrong, and gave no hint which of the 4 tabs was open. Title now
   * names both — "Card — Matched", "Online (IP + Diag/OP) — Mismatches" — and
   * the subtitle underneath explains what that combination actually shows,
   * without repeating the same words the title already said.
   */
  protected readonly headerTitle = computed(() => {
    const tabLabel = TABS.find((t) => t.id === this.activeTab())?.label ?? '';
    const viewLabel = VIEW_MODES.find((v) => v.id === this.viewMode())?.label ?? '';
    return `${tabLabel} — ${viewLabel}`;
  });

  protected readonly headerSubtitle = computed(() => {
    const tab = TAB_NOUN[this.activeTab()];
    switch (this.viewMode()) {
      case 'all':
        return `Every ${tab} transaction, matched or not — click one to see the full record.`;
      case 'matched':
        return `${tab} transactions the system has matched — click one to see the full record, or flag it as wrong.`;
      case 'matched_by_auditor':
        return `Locked by an auditor's approval — click one to see who approved it and when.`;
      case 'mismatches':
      default:
        return `Click one to see the full record and why it didn't tally.`;
    }
  });

  // ---- bulk select + propose (client ask, 2026-09-23) — Mismatches view only, current page ----
  protected readonly selectedRows = signal<ReviewRow[]>([]);
  protected readonly bulkProposeOpen = signal(false);
  protected readonly bulkReason = signal('');
  protected readonly bulkError = signal<string | null>(null);
  protected readonly bulkProgress = signal<{ done: number; total: number } | null>(null);
  protected readonly bulkResultMessage = signal<string | null>(null);

  // ---- detail dialog — one shared modal, filled differently per collection type ----
  protected readonly detail = signal<RecordDetailView | null>(null);
  private detailEntityType: ApprovalEntityType | null = null;
  private detailEntityId: string | null = null;

  // ---- change a match, from inside the detail dialog ----------------------------------
  // An Auditor proposes (maker-checker); an Admin — the final checker — decides at
  // once, and can approve or reject an Auditor's open request right here.
  protected readonly isAdmin = computed(() => this.auth.frsRole() === 'Admin');
  protected readonly proposing = signal(false);
  /** Set once a decision is applied or a request rejected — what the dialog then says. */
  protected readonly decisionMessage = signal<string | null>(null);
  protected readonly proposeReason = signal('');
  protected readonly proposeError = signal<string | null>(null);
  /**
   * The record's open request, if it has one — from its row, or set on submit.
   * While it is open the dialog says so in place of the form: the status itself
   * rightly stays as-is until the checker approves.
   */
  protected readonly detailPendingChange = signal<PendingChange | null>(null);

  // ---- AC-10 location + department -------------------------------------------------

  /** An Auditor is limited to the branches an Admin assigned them. */
  protected readonly branchRestricted = computed(() => this.auth.frsRole() === 'Auditor');

  private readonly availableLocations = computed<string[]>(() =>
    this.branchRestricted()
      ? (this.auth.profile()?.locations ?? this.auth.locations())
      : this.masterData.activeLocationNames(),
  );

  protected readonly locationOptions = computed<SelectOption<string>[]>(() => [
    { label: this.branchRestricted() ? 'All My Locations' : 'All Locations', value: null },
    ...this.availableLocations().map((name) => ({ label: name, value: name })),
  ]);

  protected readonly departmentOptions = computed<SelectOption<Department>[]>(() => [
    { label: 'All Departments', value: null },
    ...DEPARTMENTS_BY_TAB[this.activeTab()].map((d) => ({ label: DEPARTMENT_LABELS[d], value: d })),
  ]);

  /** An Auditor with no branch assigned sees nothing, rather than everything. */
  protected readonly noBranches = computed(() => this.branchRestricted() && this.availableLocations().length === 0);

  /** What the highlighted totals below the Location picker are currently scoped to. */
  protected readonly scopeLabel = computed(() => {
    const picked = this.filters().location;
    if (picked) return picked;
    return this.branchRestricted() ? 'All My Locations' : 'All Locations';
  });

  protected readonly hasFilters = computed(() => {
    const f = this.filters();
    return !!f.search.trim() || !!f.dateFrom || f.upTo !== 'BANK' || !!f.location || !!f.department || f.statuses.length > 0;
  });

  // ---- AC-12 "show up to" -----------------------------------------------------------
  protected readonly upToOptions = UP_TO_OPTIONS;

  /**
   * One line above the table saying exactly which date(s) the list stops at —
   * per branch for the bank statement, since each branch's statement reaches a
   * different day (backend src/scope-filters.js settlementCutoffs).
   */
  protected readonly cutoffNote = computed<string | null>(() => {
    const f = this.filters();
    if (f.upTo === 'AS_ON') {
      // Says the range in full, both ends, because that is what the download
      // will contain — and a partial-period file with no stated period is the
      // easiest kind to misread later.
      if (!f.asOn) return 'Showing every date — pick a To date to stop the list there.';
      return f.dateFrom
        ? `Showing ${pickedDateText(f.dateFrom)} to ${pickedDateText(f.asOn)}.`
        : `Showing everything up to ${pickedDateText(f.asOn)}.`;
    }
    const bank = this.activeDates()?.bank;
    if (!bank) return null;
    if (!bank.locationScoped) {
      return bank.dataUpTo
        ? `Showing mismatches up to the last ${bank.source} date: ${calendarDateText(bank.dataUpTo)}.`
        : `No ${bank.source} uploaded yet — showing every date.`;
    }
    const overall = calendarDateText(bank.overallDataUpTo ?? null);
    if (!overall) return 'No bank statement uploaded yet — showing every date.';
    const branches = (bank.byLocation ?? []).filter((b) => !this.branchRestricted() || this.availableLocations().includes(b.location));
    if (f.location) {
      const own = branches.find((b) => b.location === f.location);
      return own
        ? `Showing mismatches up to ${f.location}'s last bank date: ${calendarDateText(own.dataUpTo)}.`
        : `No bank statement for ${f.location} yet — showing up to the latest bank date, ${overall}.`;
    }
    if (new Set(branches.map((b) => b.dataUpTo)).size > 1) {
      return `Showing mismatches up to each branch's last bank date — ${branches.map((b) => `${b.location} ${calendarDateText(b.dataUpTo)}`).join(' · ')}.`;
    }
    return `Showing mismatches up to the last bank date: ${calendarDateText(branches[0]?.dataUpTo ?? null) ?? overall}.`;
  });

  constructor() {
    // An Auditor's picker lists only their own granted branches; everyone else sees the whole master.
    if (!this.branchRestricted()) {
      this.masterData.refreshLocations().subscribe({ error: () => undefined });
    }
    this.refresh(true);
    inject(DestroyRef).onDestroy(() => {
      if (this.searchTimer) clearTimeout(this.searchTimer);
    });
  }

  private initialTab(): TabId {
    const tab = this.route.snapshot.queryParamMap.get('tab');
    return TABS.some((t) => t.id === tab) ? (tab as TabId) : TABS[0].id;
  }

  private initialViewMode(): ViewMode {
    const mode = this.route.snapshot.queryParamMap.get('view');
    return VIEW_MODES.some((m) => m.id === mode) ? (mode as ViewMode) : 'mismatches';
  }

  /** Client mail item 15 — switch between the default mismatch list and a browse of clean, locked-eligible matches. */
  protected selectViewMode(mode: ViewMode): void {
    if (this.viewMode() === mode) return;
    this.viewMode.set(mode);
    this.router.navigate([], { queryParams: { view: mode === 'mismatches' ? null : mode }, queryParamsHandling: 'merge', relativeTo: this.route });
    this.refresh(false);
  }

  protected selectTab(id: TabId): void {
    this.activeTab.set(id);
    this.router.navigate([], { queryParams: { tab: id }, queryParamsHandling: 'merge', relativeTo: this.route });
    // Keep the department only if the new tab has data for it (e.g. no OPD cheques).
    const dept = this.filters().department;
    if (dept && !DEPARTMENTS_BY_TAB[id].includes(dept)) {
      this.filters.update((f) => ({ ...f, department: null }));
      this.refresh(true);
      return;
    }
    this.load(id, 1);
    this.refreshViewModeCounts();
  }

  // ---- filters -------------------------------------------------------------------------

  protected onSearchInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.filters.update((f) => ({ ...f, search: value }));
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.refresh(false), SEARCH_DEBOUNCE_MS);
  }

  /** From date, the up-to mode, and the as-on date — none of them move the file dates. */
  /**
   * Both date boxes are always on screen, so From-To reads as the range it is.
   *
   * Picking a To date switches the upper bound to it, and clearing it goes back
   * to the bank cut-off (AC-12's default). That coupling is what lets the To box
   * be visible at all times: it used to be hidden behind the "Show up to"
   * dropdown, and nobody looking for a date range found it there.
   */
  protected updateDateFilter(patch: Partial<Pick<Filters, 'dateFrom' | 'upTo' | 'asOn'>>): void {
    this.filters.update((f) => {
      const next = { ...f, ...patch };
      if ('asOn' in patch) next.upTo = patch.asOn ? 'AS_ON' : 'BANK';
      // Going back to the bank cut-off drops the To date, so the box does not
      // sit there showing a date that is no longer being applied.
      if (patch.upTo === 'BANK') next.asOn = null;
      return next;
    });
    this.refresh(false);
  }

  protected updateScopeFilter(patch: Partial<Pick<Filters, 'location' | 'department'>>): void {
    this.filters.update((f) => ({ ...f, ...patch }));
    this.refresh(true);
  }

  protected readonly statusOptions = STATUS_FILTER_OPTIONS;

  protected updateStatusFilter(statuses: MatchStatusFilter[]): void {
    this.filters.update((f) => ({ ...f, statuses: statuses ?? [] }));
    this.refresh(true);
  }

  protected clearFilters(): void {
    this.filters.set(emptyFilters());
    this.refresh(true);
  }

  /**
   * The `location` query param: the one picked, else — for an Auditor — all of
   * their branches, else nothing (an Admin's "All" is unrestricted).
   */
  private locationParam(): string | undefined {
    const picked = this.filters().location;
    if (picked) return picked;
    return this.branchRestricted() ? this.availableLocations().join(',') : undefined;
  }

  /**
   * Client ask: all four tabs in ONE Excel file.
   *
   * Sends the toolbar exactly as the lists send it, plus the view mode — so
   * the workbook is the screen, not a second opinion about it. Deliberately
   * NOT the Audit Working Report: that is a fixed client-approved layout of
   * every row in a period, and filtering it would put a signed-off deliverable
   * at risk for a different job (see backend/src/excel/mismatch-export.js).
   *
   * The server may refuse an unfiltered export as too large; that reads back as
   * a plain message rather than a failed download, hence the blob-to-text step.
   */
  protected downloadExport(report: ExportReport): void {
    if (this.exporting()) return;
    this.exporting.set(report);
    this.exportError.set(null);
    const f = this.filters();
    this.mismatchReview
      .downloadExport({
        // The report picked here, not the view mode: the client asked to pull a
        // Matched report without first switching the screen to Matched. Any
        // Status pick NARROWS it server-side rather than replacing it.
        mode: report,
        statuses: f.statuses.length ? f.statuses.join(',') : undefined,
        search: f.search.trim() || undefined,
        dateFrom: toDateOnly(f.dateFrom),
        upTo: f.upTo === 'BANK' ? 'BANK' : undefined,
        dateTo: f.upTo === 'AS_ON' ? toDateOnly(f.asOn) : undefined,
        location: this.locationParam(),
        department: f.department ?? undefined,
        matchedByAuditor: report === 'matched_by_auditor' ? 'true' : undefined,
      })
      .subscribe({
        next: () => this.exporting.set(null),
        error: async (err) => {
          this.exporting.set(null);
          // An error body arrives as a Blob because the request asked for one.
          let message = errorMessage(err);
          if (err?.error instanceof Blob) {
            try {
              const parsed = JSON.parse(await err.error.text());
              if (parsed?.error) message = parsed.error;
            } catch {
              /* not JSON — keep the generic message */
            }
          }
          this.exportError.set(message);
        },
      });
  }

  // ---- loading -------------------------------------------------------------------------

  /**
   * Filters changed: this tab from page 1, the other tabs' counts, and — when
   * location/department moved — the file dates, which the search and date
   * range don't affect (they describe the files, not the rows shown).
   */
  private refresh(scopeChanged: boolean): void {
    this.load(this.activeTab(), 1);
    this.refreshCounts();
    this.refreshViewModeCounts();
    this.refreshTabTotals();
    if (scopeChanged) this.refreshDates();
  }

  protected onPageChange(event: TableLazyLoadEvent): void {
    const page = Math.floor((event.first ?? 0) / (event.rows || PAGE_SIZE)) + 1;
    this.load(this.activeTab(), page);
  }

  private patchTab(tab: TabId, patch: Partial<TabState>): void {
    this.tabState.update((s) => ({ ...s, [tab]: { ...s[tab], ...patch } }));
  }

  /**
   * One page of one tab, with the toolbar filters every tab honours identically.
   * `modeOverride` lets the top-of-page breakdown ask for a view other than the
   * one currently open, without disturbing it (see refreshViewModeCounts).
   */
  private fetchPage(tab: TabId, page: number, pageSize: number, modeOverride?: ViewMode): Observable<ListPage> {
    const f = this.filters();
    const mode = modeOverride ?? this.viewMode();
    const common = {
      search: f.search.trim() || undefined,
      dateFrom: toDateOnly(f.dateFrom),
      // AC-12: till bank upload (server cuts each row at its branch's bank date), or as on a picked date.
      upTo: f.upTo === 'BANK' ? ('BANK' as const) : undefined,
      dateTo: f.upTo === 'AS_ON' ? toDateOnly(f.asOn) : undefined,
      location: this.locationParam(),
      // A tab without this department can't have been asked for it (see selectTab),
      // but a count for another tab can: send it only where it exists.
      department: f.department && DEPARTMENTS_BY_TAB[tab].includes(f.department) ? f.department : undefined,
      // 'Matched by Auditor' is a narrower look INTO 'Matched' (every clean
      // match, system or auditor-locked, per status-tone's isMatchedByAuditor)
      // — not a disjoint slice of it, so only it adds the extra filter.
      matchedByAuditor: mode === 'matched_by_auditor' ? 'true' : undefined,
    };
    // Client mail item 15 — the Matched views swap in each tab's clean-status
    // set, so an Auditor can find a locked system match to flag as wrong.
    // 'All' sends no status filter at all — that's the whole point of it.
    const wantsClean = mode === 'matched' || mode === 'matched_by_auditor';
    let onlineChequeStatuses = mode === 'mismatches' ? MISMATCH_STATUSES : wantsClean ? [...CLEAN_MATCH_STATUSES] : null;
    let ucrStatuses = mode === 'mismatches' ? UCR_MISMATCH_STATUSES : wantsClean ? UCR_CLEAN_STATUSES : null;
    // An explicit Status pick is narrower than the view mode, so it replaces it
    // rather than adding to it. Narrowed per tab because the two families of
    // tables do not share a vocabulary (see STATUS_FILTER_OPTIONS) — and an
    // EMPTY narrowing must send a filter that matches nothing, not no filter at
    // all, which the API would read as "every row".
    if (f.statuses.length) {
      const forTab = statusesForTab(f.statuses, tab);
      const list = forTab.length ? forTab : ['__NONE__'];
      onlineChequeStatuses = list;
      ucrStatuses = list;
    }
    switch (tab) {
      case 'online':
        return this.mismatchReview.fetchOnlineMismatches({ ...common, matchStatus: onlineChequeStatuses?.join(','), page, pageSize });
      case 'cheque':
        return this.chequeCollections.fetchRecords({ ...common, matchStatus: onlineChequeStatuses?.join(','), page, pageSize });
      case 'card':
        return this.ucrMatched.fetchCardRecon({ ...common, status: ucrStatuses?.join(','), page, pageSize });
      case 'upi':
        return this.ucrMatched.fetchUpiRecon({ ...common, status: ucrStatuses?.join(','), page, pageSize });
    }
  }

  private load(tab: TabId, page: number): void {
    this.listError.set(null);
    // The row set that's about to change — any bulk selection from it goes stale.
    this.selectedRows.set([]);
    const seq = ++this.listSeq;
    if (this.noBranches()) {
      // Never fall through to an unscoped query — that would show every branch.
      this.tabState.set(emptyTabs());
      this.loading.set(false);
      return;
    }
    this.loading.set(true);
    this.patchTab(tab, { page });
    this.fetchPage(tab, page, PAGE_SIZE).subscribe({
      next: (res) => {
        if (seq !== this.listSeq) return;
        this.loading.set(false);
        this.patchTab(tab, { rows: res.records, total: res.total });
      },
      error: (err) => {
        if (seq !== this.listSeq) return;
        this.loading.set(false);
        this.listError.set(errorMessage(err));
      },
    });
  }

  /** The tab badges: every other tab's count under the same filters (the active one comes with its page). */
  private refreshCounts(): void {
    const seq = ++this.countSeq;
    if (this.noBranches()) return;
    for (const { id } of TABS) {
      if (id === this.activeTab()) continue;
      this.fetchPage(id, 1, 1).subscribe({
        next: (res) => {
          if (seq === this.countSeq) this.patchTab(id, { total: res.total });
        },
        error: () => undefined, // a badge is a convenience; the tab reports its own error when opened
      });
    }
  }

  /**
   * Client ask: "how many records has it done the recon for" at the top of
   * the page — every view's count against the active tab's total (e.g.
   * Mismatched 20/300, Matched 200/300), regardless of which view is open.
   * Scoped to the active tab only, under the same toolbar filters.
   */
  private refreshViewModeCounts(): void {
    const seq = ++this.viewModeCountSeq;
    if (this.noBranches()) {
      this.viewModeCounts.set({ all: 0, mismatches: 0, matched: 0, matched_by_auditor: 0 });
      return;
    }
    const tab = this.activeTab();
    for (const { id } of VIEW_MODES) {
      this.fetchPage(tab, 1, 1, id).subscribe({
        next: (res) => {
          if (seq === this.viewModeCountSeq) this.viewModeCounts.update((c) => ({ ...c, [id]: res.total }));
        },
        error: () => undefined, // a badge is a convenience; the table reports its own error when opened
      });
    }
  }

  /**
   * Client ask: Online/Cheque/Card/UPI's own record totals, highlighted at
   * the very top — every collection type at once, regardless of which tab or
   * view is currently open. Under the same toolbar filters as everything else.
   */
  private refreshTabTotals(): void {
    const seq = ++this.tabTotalsSeq;
    if (this.noBranches()) {
      this.tabTotals.set({ online: 0, cheque: 0, card: 0, upi: 0 });
      return;
    }
    for (const { id } of TABS) {
      this.fetchPage(id, 1, 1, 'all').subscribe({
        next: (res) => {
          if (seq === this.tabTotalsSeq) this.tabTotals.update((t) => ({ ...t, [id]: res.total }));
        },
        error: () => undefined, // a highlight tile is a convenience; the tab reports its own error when opened
      });
    }
  }

  protected tabTotal(tab: TabId): number | null {
    return this.tabTotals()[tab];
  }

  /** The lead tile: every collection type's total added together. Null until all four have loaded. */
  protected readonly allRecordsTotal = computed<number | null>(() => {
    const totals = TABS.map(({ id }) => this.tabTotals()[id]);
    return totals.some((n) => n === null) ? null : totals.reduce<number>((sum, n) => sum + (n ?? 0), 0);
  });

  /** 'All' shows its own total; every other view shows count/total against it. Null while either is still loading. */
  protected viewModeBadge(mode: ViewMode): string | null {
    const counts = this.viewModeCounts();
    const total = counts.all;
    const n = counts[mode];
    if (total === null || n === null) return null;
    return mode === 'all' ? String(total) : `${n}/${total}`;
  }

  protected viewModeBadgeClass(mode: ViewMode): string {
    return `view-toggle__count--${VIEW_MODE_TONE[mode]}`;
  }

  private refreshDates(): void {
    const seq = ++this.datesSeq;
    if (this.noBranches()) {
      this.dates.set(null);
      return;
    }
    const dept = this.filters().department;
    this.mismatchReview.fetchReconciliationDates({ location: this.locationParam(), department: dept ?? undefined }).subscribe({
      next: (dates) => {
        if (seq === this.datesSeq) this.dates.set(dates);
      },
      error: () => undefined,
    });
  }

  protected tabCount(tab: TabId): number | null {
    return this.tabState()[tab].total;
  }

  // ---- cell + card formatting ------------------------------------------------------------

  /** AC-16: green/red/orange, the same rule as the exported files (AC-17). */
  protected statusPillClass(status: string | null, matchedByAuditor = false): string {
    switch (statusTone(status, matchedByAuditor)) {
      case 'GREEN': return 'status-pill--green';
      case 'ORANGE': return 'status-pill--orange';
      case 'RED': return 'status-pill--red';
      default: return 'status-pill--red';
    }
  }

  /** The pill's icon, same tone rule: ✓ matched, auditor, ↘ still open. */
  protected statusIcon(status: string | null, matchedByAuditor = false): string {
    switch (statusTone(status, matchedByAuditor)) {
      case 'GREEN': return 'pi-check';
      case 'ORANGE': return 'pi-user-edit';
      default: return 'pi-arrow-down-right';
    }
  }

  /** Dot colour for the IP / OP / Diag chip — the same category colours as the dashboard's By Payment Type. */
  protected typeColor(value: unknown): string {
    const v = String(value ?? '').toLowerCase();
    // OP sits in the dashboard's "Diagnostics / OP Payments" row, so it shares its orange.
    if (v.includes('diag') || v === 'op' || v.startsWith('op')) return 'var(--ai-orange)';
    if (v.includes('cheque')) return '#db2777';
    if (v.includes('card')) return '#2563eb';
    if (v.includes('upi')) return '#0d9488';
    if (v === 'ip' || v.startsWith('ip')) return 'var(--ai-purple)';
    return 'var(--text-subtle)';
  }

  /**
   * Wording shared with every Excel the client gets (backend
   * reconciliation/status-tone.js STATUS_LABEL). Kept identical on purpose —
   * a verdict that reads one way on screen and another in the download is the
   * kind of thing a client raises as a bug.
   */
  protected statusLabel(status: string | null, matchedByAuditor = false): string {
    if (matchedByAuditor) return 'Matched by Auditor';
    // `status` is whatever the API sent, so it is narrowed here rather than
    // trusted — an unknown verdict falls through to its own raw value.
    return STATUS_LABELS[status as MatchStatusFilter] ?? status ?? 'Not Generated';
  }

  protected amount(value: CellValue): string {
    return typeof value === 'number' ? amountText(value) : '—';
  }

  protected calendarDate(ymd: string | null): string | null {
    return calendarDateText(ymd);
  }

  /** Client mail item 15 — a clean match's propose flow is a Correction (unlock + reset), not the usual propose-as-matched. */
  protected isCleanMatch(status: string | null): boolean {
    return !!status && CLEAN_MATCH_STATUSES.has(status);
  }

  // ---- click-to-detail — full record + plain-English reason, per type -----------------

  protected openDetail(row: ReviewRow): void {
    switch (this.activeTab()) {
      case 'online': return this.openOnlineDetail(row as OnlineMismatchRecord);
      case 'cheque': return this.openChequeDetail(row as ChequeCollectionRecord);
      case 'card': return this.openUcrDetail(row as UcrIpRecord, 'Card');
      case 'upi': return this.openUcrDetail(row as UcrIpRecord, 'UPI');
    }
  }

  /** Opens the dialog on one record and arms the propose panel for it. */
  private showDetail(view: RecordDetailView, entityType: ApprovalEntityType, row: ReviewRow): void {
    this.detail.set(view);
    this.detailEntityType = entityType;
    this.detailEntityId = row.id;
    this.resetProposeState();
    this.detailPendingChange.set(row.pendingChange ?? null);
  }

  /** The dialog fields every record type shares: status, reason, place and patient. */
  private detailBase(row: ReviewRow, patientName: string | null, department: string) {
    return {
      status: row.matchStatus,
      statusLabel: this.statusLabel(row.matchStatus, row.matchedByAuditor),
      tone: statusTone(row.matchStatus, row.matchedByAuditor),
      matchedByAuditor: row.matchedByAuditor,
      reason: row.matchReason,
      patientName,
      receiptDate: row.receiptDate,
      location: locationOf(row),
      department,
    };
  }

  private openOnlineDetail(row: OnlineMismatchRecord): void {
    const isIp = row.recordType === 'IP';
    this.showDetail({
      ...this.detailBase(row, row.patientName, onlineDepartment(row)),
      typeLabel: isIp ? 'IP Receipt' : 'Diagnostics/OP Receipt',
      icon: 'pi pi-globe',
      receiptNo: row.receiptNumber || '—',
      amountLabel: 'Bill Amount',
      amount: splitAmount(row.billAmount),
      paymentMode: row.paymentMode,
      sections: [
        { title: 'Patient', icon: 'pi pi-user', fields: [
          { label: isIp ? 'IP No' : 'Diag No', value: row.unitNo, ref: true },
          { label: 'YH No', value: row.yhno, ref: true },
          { label: 'Patient Type', value: row.patType },
          { label: 'Collected By', value: collectedBy(row) },
        ] },
        { title: 'Payment Split', icon: 'pi pi-wallet', fields: [
          { label: 'Pay Type', value: row.payType },
          { label: 'Cash', value: splitAmount(row.cashAmount) },
          { label: 'Card', value: splitAmount(row.cardAmount) },
          { label: 'Cheque', value: splitAmount(row.chequeAmount) },
          { label: 'Online / UPI', value: splitAmount(row.onlineUpiAmount) },
          { label: 'Discount', value: splitAmount(row.discountAmount) },
          { label: 'Difference', value: splitAmount(row.diffAmount) },
        ] },
        { title: 'References', icon: 'pi pi-hashtag', fields: [
          { label: 'Transaction Ref 1', value: row.transactionRef1, ref: true },
          { label: 'Transaction Ref 2', value: row.transactionRef2, ref: true },
          { label: 'Trans ID', value: row.transId, ref: true },
        ] },
        { title: 'Matching', icon: 'pi pi-sitemap', fields: [
          { label: 'Rule Applied', value: row.matchAppliedRule },
          { label: 'Unit / Group', value: row.matchUnitKey, ref: true },
          { label: 'Transactions in Unit', value: row.matchUnitKey ? String(row.matchUnitCount ?? '') : null },
          { label: 'Unit Total', value: row.matchUnitKey ? amountText(row.matchUnitTotal) : null },
          { label: 'Unit Difference', value: row.matchUnitKey ? amountText(row.matchUnitDifference) : null },
        ] },
        { title: 'Remarks', icon: 'pi pi-comment', fields: [
          { label: 'Remarks', value: row.remarks },
          { label: 'Payment Remarks', value: row.paymentRemarks },
        ] },
      ],
    }, row.recordType, row);
  }

  private openChequeDetail(row: ChequeCollectionRecord): void {
    this.showDetail({
      ...this.detailBase(row, row.patientName, chequeDepartment(row)),
      typeLabel: 'Cheque Receipt',
      icon: 'pi pi-file',
      receiptNo: row.receiptNumber || '—',
      amountLabel: 'Cheque Amount',
      amount: splitAmount(row.chequeAmount),
      paymentMode: 'Cheque',
      sections: [
        { title: 'Patient', icon: 'pi pi-user', fields: [
          { label: 'IP No', value: row.ipNo, ref: true },
          { label: 'Diag No', value: row.diagNo, ref: true },
          { label: 'YH No', value: row.yhno, ref: true },
          { label: 'Patient Type', value: row.patType },
          { label: 'Collected By', value: collectedBy(row) },
        ] },
        { title: 'Cheque', icon: 'pi pi-file', fields: [
          { label: 'Cheque No', value: row.chequeNo, ref: true },
          { label: 'Cheque Date', value: dateText(row.chequeDate) },
          { label: 'Bank', value: row.bankName },
          { label: 'Branch', value: row.branchName },
          { label: 'Pay Type', value: row.payType },
        ] },
        { title: 'Amounts', icon: 'pi pi-indian-rupee', fields: [
          { label: 'Bill Amount', value: splitAmount(row.billAmount) },
          { label: 'Receipt Amount', value: splitAmount(row.receiptAmount) },
        ] },
        { title: 'Matching', icon: 'pi pi-sitemap', fields: [
          { label: 'Rule Applied', value: row.matchAppliedRule },
        ] },
      ],
    }, 'CHEQUE', row);
  }

  private openUcrDetail(row: UcrIpRecord, kind: 'Card' | 'UPI'): void {
    const src = row.matchedSource;
    this.showDetail({
      ...this.detailBase(row, row.patientName, ucrDepartment(row)),
      typeLabel: `${kind} Receipt`,
      icon: kind === 'Card' ? 'pi pi-credit-card' : 'pi pi-mobile',
      receiptNo: row.receiptNo || '—',
      amountLabel: 'Amount',
      amount: splitAmount(row.amount),
      paymentMode: kind,
      sections: [
        { title: 'Patient', icon: 'pi pi-user', fields: [
          { label: 'IP No', value: row.ipNo, ref: true },
          { label: 'Diag No', value: row.diagNo ?? null, ref: true },
          { label: 'YH No', value: row.yhNo, ref: true },
          { label: 'Bill No', value: row.billNo, ref: true },
          { label: 'Collected By', value: collectedBy(row) },
        ] },
        { title: 'References', icon: 'pi pi-hashtag', fields: [
          { label: kind === 'Card' ? 'Approval Code' : 'UPI Reference', value: row.referenceId, ref: true },
        ] },
        { title: 'Gateway Match', icon: 'pi pi-arrow-right-arrow-left', fields: src
          ? [
              { label: 'Matched In', value: src.sourceType ? GATEWAY_LABELS[src.sourceType] ?? src.sourceType : null },
              { label: 'Gateway Reference', value: src.reference, ref: true },
              { label: 'Gateway Amount', value: splitAmount(src.amount) },
              { label: 'Settled On', value: dateText(src.date) },
            ]
          : [{ label: 'Matched In', value: 'No matching gateway row found' }] },
      ],
    }, kind === 'Card' ? 'CARD' : 'UPI', row);
  }

  protected closeDetail(): void {
    this.detail.set(null);
    this.detailEntityType = null;
    this.detailEntityId = null;
  }

  // ---- propose match — Auditor only, maker-checker (client mail point 2) --------------

  private resetProposeState(): void {
    this.proposing.set(false);
    this.proposeReason.set('');
    this.proposeError.set(null);
    this.decisionMessage.set(null);
  }

  /** Who may change this record's match: an Auditor or an Admin; an auditor-approved lock is final. */
  protected canChangeMatch(d: RecordDetailView): boolean {
    const role = this.auth.frsRole();
    return (role === 'Auditor' || role === 'Admin') && !d.matchedByAuditor;
  }

  protected submitProposeMatch(): void {
    const entityType = this.detailEntityType;
    const entityId = this.detailEntityId;
    if (!entityType || !entityId) return;
    if (!this.proposeReason().trim()) {
      this.proposeError.set('A reason is required.');
      return;
    }
    const tab = this.activeTab();
    this.proposing.set(true);
    this.proposeError.set(null);
    this.matchApproval.propose(entityType, entityId, this.proposeReason().trim()).subscribe({
      next: (created) => {
        this.proposing.set(false);
        if (created.status === 'APPROVED' && created.applied) {
          // An Admin's decision — already applied.
          const message = created.proposedStatus === 'UNMATCHED'
            ? 'Reset to Unmatched and unlocked — the next Generate decides it again.'
            : 'Marked as Matched and locked. Recorded in the Audit Log under your name.';
          this.applyDecision(tab, entityType, entityId, created.applied, message);
          return;
        }
        const pending: PendingChange = {
          id: created.id,
          proposedStatus: created.proposedStatus,
          requestedAt: created.requestedAt,
          requestedBy: this.auth.fullName(),
        };
        this.detailPendingChange.set(pending);
        this.markRowPending(tab, entityType, entityId, pending);
      },
      error: (err) => {
        this.proposing.set(false);
        this.proposeError.set(errorMessage(err));
        // Already asked (another tab, or someone else first): reload so the row shows it.
        if (err?.status === 409) this.load(tab, this.tabState()[tab].page);
      },
    });
  }

  /** Admin: approve the Auditor's open request on this record (the note is optional). */
  protected approvePending(): void {
    const pending = this.detailPendingChange();
    const entityType = this.detailEntityType;
    const entityId = this.detailEntityId;
    if (!pending || !entityType || !entityId) return;
    const tab = this.activeTab();
    this.proposing.set(true);
    this.proposeError.set(null);
    this.matchApproval.approve(pending.id, this.proposeReason().trim() || undefined).subscribe({
      next: (res) => {
        this.proposing.set(false);
        if (res.applied) this.applyDecision(tab, entityType, entityId, res.applied, 'Request approved and applied.');
      },
      error: (err) => {
        this.proposing.set(false);
        this.proposeError.set(errorMessage(err));
      },
    });
  }

  /** Admin: reject it — a note is required; the record is left as it is and can be proposed again. */
  protected rejectPending(): void {
    const pending = this.detailPendingChange();
    const entityType = this.detailEntityType;
    const entityId = this.detailEntityId;
    if (!pending || !entityType || !entityId) return;
    const note = this.proposeReason().trim();
    if (!note) {
      this.proposeError.set('A note is required to reject — it tells the Auditor why.');
      return;
    }
    const tab = this.activeTab();
    this.proposing.set(true);
    this.proposeError.set(null);
    this.matchApproval.reject(pending.id, note).subscribe({
      next: () => {
        this.proposing.set(false);
        this.detailPendingChange.set(null);
        this.patchRow(tab, entityType, entityId, { pendingChange: null });
        this.decisionMessage.set('Request rejected — the record is unchanged, and the Auditor can propose again.');
      },
      error: (err) => {
        this.proposing.set(false);
        this.proposeError.set(errorMessage(err));
      },
    });
  }

  /** A decision is in: show it in the dialog and on the table row, without refetching the page. */
  private applyDecision(tab: TabId, entityType: ApprovalEntityType, entityId: string, applied: AppliedMatch, message: string): void {
    const status = applied.matchStatus;
    this.detail.update((d) =>
      d && {
        ...d,
        status,
        statusLabel: this.statusLabel(status, applied.matchedByAuditor),
        tone: statusTone(status, applied.matchedByAuditor),
        matchedByAuditor: applied.matchedByAuditor,
        reason: applied.matchReason,
      },
    );
    this.detailPendingChange.set(null);
    this.proposeReason.set('');
    this.decisionMessage.set(message);
    this.patchRow(tab, entityType, entityId, {
      matchStatus: status,
      matchReason: applied.matchReason,
      matchedByAuditor: applied.matchedByAuditor,
      lockedAt: applied.matchedByAuditor ? new Date().toISOString() : null,
      pendingChange: null,
    });
  }

  private patchRow(tab: TabId, entityType: ApprovalEntityType, entityId: string, patch: Record<string, unknown>): void {
    const rows = this.tabState()[tab].rows.map((row) =>
      row.id === entityId && rowEntityType(tab, row) === entityType ? ({ ...row, ...patch } as ReviewRow) : row,
    );
    this.patchTab(tab, { rows });
  }

  /** Show a new request on its table row straight away, without refetching the page. */
  private markRowPending(tab: TabId, entityType: ApprovalEntityType, entityId: string, pending: PendingChange): void {
    this.patchRow(tab, entityType, entityId, { pendingChange: pending });
  }

  /** The record-only half of applyDecision — for the bulk flow below, which has no single-record dialog to also update. */
  private applyRowChange(tab: TabId, entityType: ApprovalEntityType, entityId: string, applied: AppliedMatch): void {
    this.patchRow(tab, entityType, entityId, {
      matchStatus: applied.matchStatus,
      matchReason: applied.matchReason,
      matchedByAuditor: applied.matchedByAuditor,
      lockedAt: applied.matchedByAuditor ? new Date().toISOString() : null,
      pendingChange: null,
    });
  }

  // ---- bulk propose — Auditor multi-select on the Mismatches view (client ask, 2026-09-23) --

  protected clearSelection(): void {
    this.selectedRows.set([]);
  }

  protected openBulkPropose(): void {
    if (this.selectedRows().length === 0) return;
    this.bulkProposeOpen.set(true);
    this.bulkReason.set('');
    this.bulkError.set(null);
    this.bulkResultMessage.set(null);
  }

  /** Blocked while a batch is running — closing mid-run would leave its outcome unseen. */
  protected closeBulkPropose(): void {
    if (this.bulkProgress()) return;
    this.bulkProposeOpen.set(false);
  }

  /**
   * One propose call per selected row, sequential (not parallel) so the
   * dialog can show real "N of M" progress and a per-row failure — e.g. a
   * row someone else already proposed a change on (409) — doesn't stop the
   * rest of the batch, same principle as the insurance module's bulk AI fill.
   */
  protected submitBulkPropose(): void {
    const reason = this.bulkReason().trim();
    if (!reason) {
      this.bulkError.set('A reason is required.');
      return;
    }
    const rows = this.selectedRows();
    if (rows.length === 0) return;
    const tab = this.activeTab();
    this.bulkError.set(null);
    this.bulkResultMessage.set(null);
    this.bulkProgress.set({ done: 0, total: rows.length });
    let succeeded = 0;
    const failures: string[] = [];

    const runNext = (index: number): void => {
      if (index >= rows.length) {
        this.bulkProgress.set(null);
        this.selectedRows.set([]);
        this.bulkResultMessage.set(
          failures.length === 0
            ? `${succeeded} of ${rows.length} submitted for approval.`
            : `${succeeded} of ${rows.length} submitted for approval. ${failures.length} could not be: ${failures.slice(0, 3).join('; ')}${failures.length > 3 ? '…' : ''}`,
        );
        return;
      }
      const row = rows[index];
      const entityType = rowEntityType(tab, row);
      this.matchApproval.propose(entityType, row.id, reason).subscribe({
        next: (created) => {
          succeeded++;
          if (created.status === 'APPROVED' && created.applied) {
            // An Admin's own bulk proposal — decided and applied at once, same as the single-row flow.
            this.applyRowChange(tab, entityType, row.id, created.applied);
          } else {
            this.markRowPending(tab, entityType, row.id, {
              id: created.id,
              proposedStatus: created.proposedStatus,
              requestedAt: created.requestedAt,
              requestedBy: this.auth.fullName(),
            });
          }
          this.bulkProgress.set({ done: index + 1, total: rows.length });
          runNext(index + 1);
        },
        error: (err) => {
          failures.push(`${rowReceiptLabel(row)}: ${errorMessage(err)}`);
          this.bulkProgress.set({ done: index + 1, total: rows.length });
          runNext(index + 1);
        },
      });
    };
    runNext(0);
  }
}
