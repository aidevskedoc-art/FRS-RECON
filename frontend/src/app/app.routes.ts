import { Route, Routes } from '@angular/router';
import { authGuard, frsAdminGuard, loginRedirectGuard, mustChangePasswordGuard, screenAccessGuard } from './core/guards/auth.guard';
import { APP_SHORT_NAME } from './core/config/app-name';

/** Per-user screen access (core/config/screens.ts) — spread into a route to gate it by URL. */
function screen(screenKey: string): Pick<Route, 'canActivate' | 'data'> {
  return { canActivate: [screenAccessGuard], data: { screenKey } };
}

export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () => import('./features/auth/login/login.component').then((m) => m.LoginComponent),
    canActivate: [loginRedirectGuard],
    title: `Sign In — ${APP_SHORT_NAME}`,
  },
  {
    // Outside the shell, same as /login — must be authenticated to reach it
    // (needs a token to call PUT /api/auth/change-password) but deliberately
    // has no sidebar to route around it while mustChangePasswordGuard applies.
    path: 'change-password',
    loadComponent: () =>
      import('./features/auth/change-password/change-password.component').then((m) => m.ChangePasswordComponent),
    canActivate: [authGuard],
    title: `Set Password — ${APP_SHORT_NAME}`,
  },
  {
    path: '',
    loadComponent: () => import('./layout/shell/shell.component').then((m) => m.ShellComponent),
    canActivate: [authGuard, mustChangePasswordGuard],
    children: [
      // The app opens on the overview dashboard. It is never screen-gated, so
      // it is also where a denied screen sends you — no redirect loop.
      { path: '', redirectTo: 'dashboard', pathMatch: 'full' },
      {
        path: 'dashboard',
        loadComponent: () =>
          import('./features/dashboard/overview-dashboard.component').then((m) => m.OverviewDashboardComponent),
        title: `Dashboard — ${APP_SHORT_NAME}`,
      },

      // ---- Automation Insurance ------------------------------------------------
      {
        path: 'insurance-policy/dashboard',
        ...screen('insurance-dashboard'),
        loadComponent: () =>
          import('./features/insurance-policy/dashboard/dashboard.component').then((m) => m.DashboardComponent),
        title: `Insurance Dashboard — ${APP_SHORT_NAME}`,
      },
      {
        path: 'insurance-policy/upload',
        ...screen('insurance-upload'),
        loadComponent: () =>
          import('./features/insurance-policy/upload/upload.component').then((m) => m.UploadComponent),
        title: `Upload — ${APP_SHORT_NAME}`,
      },
      // The processing/document workspace steps are reached from an upload, so
      // they ride the Upload Documents grant.
      {
        path: 'insurance-policy/processing',
        ...screen('insurance-upload'),
        loadComponent: () =>
          import('./features/insurance-policy/processing/processing.component').then((m) => m.ProcessingComponent),
        title: `Processing — ${APP_SHORT_NAME}`,
      },
      {
        path: 'insurance-policy/documents/:id/processing',
        ...screen('insurance-upload'),
        loadComponent: () =>
          import('./features/insurance-policy/processing/processing.component').then((m) => m.ProcessingComponent),
        title: `Processing — ${APP_SHORT_NAME}`,
      },
      {
        path: 'insurance-policy/documents/:id/extraction',
        ...screen('insurance-upload'),
        loadComponent: () =>
          import('./features/insurance-policy/extraction/extraction.component').then((m) => m.ExtractionComponent),
        title: `Extraction Workspace — ${APP_SHORT_NAME}`,
      },
      {
        path: 'insurance-policy/documents/:id/validation',
        ...screen('insurance-upload'),
        loadComponent: () =>
          import('./features/insurance-policy/validation/validation.component').then((m) => m.ValidationComponent),
        title: `Validation Center — ${APP_SHORT_NAME}`,
      },
      {
        path: 'insurance-policy/documents/:id/review',
        ...screen('insurance-upload'),
        loadComponent: () =>
          import('./features/insurance-policy/review/review.component').then((m) => m.ReviewComponent),
        title: `Final Review — ${APP_SHORT_NAME}`,
      },
      {
        path: 'insurance-policy/documents/:id/success',
        ...screen('insurance-upload'),
        loadComponent: () =>
          import('./features/insurance-policy/success/success.component').then((m) => m.SuccessComponent),
        title: `Saved — ${APP_SHORT_NAME}`,
      },
      {
        path: 'insurance-policy/excel-preview',
        ...screen('insurance-excel-export'),
        loadComponent: () =>
          import('./features/insurance-policy/excel-preview/excel-preview.component').then(
            (m) => m.ExcelPreviewComponent,
          ),
        title: `Excel Preview — ${APP_SHORT_NAME}`,
      },
      {
        path: 'insurance-policy/history',
        ...screen('insurance-history'),
        loadComponent: () =>
          import('./features/insurance-policy/history/history.component').then((m) => m.HistoryComponent),
        title: `Processing History — ${APP_SHORT_NAME}`,
      },

      // ---- Reconciliation --------------------------------------------------------
      {
        path: 'how-to-use',
        ...screen('how-to-use'),
        loadComponent: () => import('./features/how-to-use/how-to-use.component').then((m) => m.HowToUseComponent),
        title: `How to Use — ${APP_SHORT_NAME}`,
      },
      // Upload hubs — superseded by the /reconciliation screen, which uploads
      // every one of these report types itself. Kept as redirects so old
      // links/bookmarks still land somewhere useful; the target's own screen
      // guard applies after the redirect.
      { path: 'upload-online/collections', redirectTo: 'reconciliation', pathMatch: 'full' },
      { path: 'upload-online/mis', redirectTo: 'reconciliation', pathMatch: 'full' },
      { path: 'upload-online/bank-feeds', redirectTo: 'reconciliation', pathMatch: 'full' },
      { path: 'upload-online/bank-statement', redirectTo: 'reconciliation', pathMatch: 'full' },
      { path: 'upload-online/payu-mpr-upload', redirectTo: 'reconciliation', pathMatch: 'full' },
      { path: 'upload-online/easebuzz-upload', redirectTo: 'reconciliation', pathMatch: 'full' },
      { path: 'upload-online/ucr-feeds', redirectTo: 'reconciliation', pathMatch: 'full' },
      // Batch/statement list screens — folded into the one tabbed Statements page below.
      { path: 'upload-online/payu-mpr', redirectTo: 'upload-online/statements', pathMatch: 'full' },
      { path: 'upload-online/easebuzz', redirectTo: 'upload-online/statements', pathMatch: 'full' },
      { path: 'upload-online/ucr-batches', redirectTo: 'upload-online/statements', pathMatch: 'full' },
      {
        // Every uploaded-batch list (bank / PayU / EaseBuzz / UPI & Card /
        // IP / Diag OP / cheque / refund) in one place, as tabs.
        path: 'upload-online/statements',
        ...screen('statements'),
        loadComponent: () =>
          import('./features/upload-online/statements/statements.component').then((m) => m.StatementsComponent),
        title: `Statements — ${APP_SHORT_NAME}`,
      },
      // Legacy, off-nav: these two read online_upload_batches, the
      // pre-migration MIS table. POST /api/online-upload/mis now rejects every
      // upload (see online-upload.routes.js), so the table is frozen and these
      // pages exist only to read historical batches by URL. Batch drill-downs
      // ride the Statements grant.
      {
        path: 'upload-online/payments',
        ...screen('statements'),
        loadComponent: () =>
          import('./features/upload-online/view-payments/view-payments.component').then(
            (m) => m.ViewPaymentsComponent,
          ),
        title: `Legacy MIS Batches (Archive) — ${APP_SHORT_NAME}`,
      },
      {
        path: 'upload-online/payments/:batchId',
        ...screen('statements'),
        loadComponent: () =>
          import('./features/upload-online/payment-batch-detail/payment-batch-detail.component').then(
            (m) => m.PaymentBatchDetailComponent,
          ),
        title: `Legacy MIS Batch (Archive) — ${APP_SHORT_NAME}`,
      },
      { path: 'upload-online/ip-payments', redirectTo: 'upload-online/statements', pathMatch: 'full' },
      {
        path: 'upload-online/ip-payments/:batchId',
        ...screen('statements'),
        loadComponent: () =>
          import('./features/upload-online/ip-payment-batch-detail/ip-payment-batch-detail.component').then(
            (m) => m.IpPaymentBatchDetailComponent,
          ),
        title: 'IP Payment Batch — Online Payments',
      },
      { path: 'upload-online/diag-op-payments', redirectTo: 'upload-online/statements', pathMatch: 'full' },
      {
        path: 'upload-online/diag-op-payments/:batchId',
        ...screen('statements'),
        loadComponent: () =>
          import('./features/upload-online/diag-op-payment-batch-detail/diag-op-payment-batch-detail.component').then(
            (m) => m.DiagOpPaymentBatchDetailComponent,
          ),
        title: 'Diag OP Payment Batch — Online Payments',
      },
      { path: 'upload-online/cheque-collection', redirectTo: 'reconciliation', pathMatch: 'full' },
      { path: 'upload-online/cheque-collections', redirectTo: 'upload-online/statements', pathMatch: 'full' },
      { path: 'upload-online/diag-cheque-collections', redirectTo: 'upload-online/statements', pathMatch: 'full' },
      {
        path: 'upload-online/cheque-collections/:batchId',
        ...screen('statements'),
        loadComponent: () =>
          import(
            './features/upload-online/cheque-collection-batch-detail/cheque-collection-batch-detail.component'
          ).then((m) => m.ChequeCollectionBatchDetailComponent),
        title: 'Cheque Collection Batch — Cheque & Refunds',
      },
      { path: 'upload-online/refund-document', redirectTo: 'reconciliation', pathMatch: 'full' },
      { path: 'upload-online/refund-documents', redirectTo: 'upload-online/statements', pathMatch: 'full' },
      { path: 'upload-online/bank-statements', redirectTo: 'upload-online/statements', pathMatch: 'full' },
      {
        path: 'upload-online/bank-statements/:batchId',
        ...screen('statements'),
        loadComponent: () =>
          import('./features/upload-online/bank-statement-batch-detail/bank-statement-batch-detail.component').then(
            (m) => m.BankStatementBatchDetailComponent,
          ),
        title: 'Bank Statement Transactions — Bank & PayU',
      },
      // Reconciliation result screens — folded into one tabbed page below.
      { path: 'matched-rules/summary', redirectTo: 'matched-rules/results', pathMatch: 'full' },
      { path: 'matched-rules/unit-matches', redirectTo: 'matched-rules/results', pathMatch: 'full' },
      { path: 'matched-rules/payu-settlements', redirectTo: 'matched-rules/results', pathMatch: 'full' },
      { path: 'matched-rules/easebuzz-settlements', redirectTo: 'matched-rules/results', pathMatch: 'full' },
      { path: 'matched-rules/card-reconciliation', redirectTo: 'matched-rules/results', pathMatch: 'full' },
      { path: 'matched-rules/upi-reconciliation', redirectTo: 'matched-rules/results', pathMatch: 'full' },
      { path: 'matched-rules/audit-report', redirectTo: 'matched-rules/results', pathMatch: 'full' },
      { path: 'matched-rules/ip-payment-rules', redirectTo: 'matched-rules/results', pathMatch: 'full' },
      { path: 'matched-rules/diagnostics-payment-rules', redirectTo: 'matched-rules/results', pathMatch: 'full' },
      {
        // Every reconciliation result screen (Summary, Audit Report, Unit
        // Matches, PayU/EaseBuzz Settlements, Card/UPI Reconciliation, IP/Diag
        // Payment Rules) in one place, as tabs.
        path: 'matched-rules/results',
        ...screen('reconciliation-results'),
        loadComponent: () =>
          import('./features/matched-rules/reconciliation-results/reconciliation-results.component').then(
            (m) => m.ReconciliationResultsComponent,
          ),
        title: 'Reconciliation Results — Reconciliation',
      },
      {
        // The consolidated screen: drop every report in one place, run all
        // reconciliations from one button, read the result below it.
        path: 'reconciliation',
        ...screen('upload-run'),
        loadComponent: () =>
          import('./features/reconciliation/reconciliation.component').then((m) => m.ReconciliationComponent),
        title: `Upload & Run — ${APP_SHORT_NAME}`,
      },
      {
        // Mismatches-only, tab per collection type, click-through to full
        // record + reason (client mail AC-7/8).
        path: 'reconciliation/mismatches',
        ...screen('mismatch-review'),
        loadComponent: () =>
          import('./features/mismatch-review/mismatch-review.component').then((m) => m.MismatchReviewComponent),
        title: `Mismatch Review — ${APP_SHORT_NAME}`,
      },
      {
        // Maker-checker (client mail point 2).
        path: 'reconciliation/approvals',
        ...screen('match-approvals'),
        loadComponent: () =>
          import('./features/pending-approvals/pending-approvals.component').then((m) => m.PendingApprovalsComponent),
        title: `Match Approvals — ${APP_SHORT_NAME}`,
      },
      {
        // Shared-folder automation (client mail point 3) — Admin-only by role:
        // its backend routes require role='Admin', so it is not a grantable screen.
        path: 'reconciliation/folder-watch',
        canActivate: [frsAdminGuard],
        loadComponent: () =>
          import('./features/folder-watch/folder-watch.component').then((m) => m.FolderWatchComponent),
        title: `Shared Folder Automation — ${APP_SHORT_NAME}`,
      },
      {
        // Client mail items 8 & 15 — the shared go-live switch. Admin-only by role.
        path: 'reconciliation/go-live-settings',
        canActivate: [frsAdminGuard],
        loadComponent: () =>
          import('./features/go-live-settings/go-live-settings.component').then((m) => m.GoLiveSettingsComponent),
        title: `Go-Live Settings — ${APP_SHORT_NAME}`,
      },
      // Rule editors — folded into one tabbed Manage Rules page below.
      { path: 'matched-rules/ip-payment-rules/manage', redirectTo: 'matched-rules/manage-rules', pathMatch: 'full' },
      { path: 'matched-rules/diagnostics-payment-rules/manage', redirectTo: 'matched-rules/manage-rules', pathMatch: 'full' },
      { path: 'matched-rules/cheque-collection-rules/manage', redirectTo: 'matched-rules/manage-rules', pathMatch: 'full' },
      { path: 'matched-rules/gateway-rules/manage', redirectTo: 'matched-rules/manage-rules', pathMatch: 'full' },
      {
        // Every rule editor (IP/Diagnostics/Cheque Matching, Gateway Matching)
        // in one place, as tabs. `?target=` still picks which of the four
        // gateway reconciliations the Gateway tab opens on.
        path: 'matched-rules/manage-rules',
        ...screen('manage-rules'),
        loadComponent: () =>
          import('./features/matched-rules/manage-rules/manage-rules.component').then((m) => m.ManageRulesComponent),
        title: 'Manage Rules — Reconciliation',
      },

      // ---- Master data -----------------------------------------------------------
      {
        path: 'master-data/division-bank-accounts',
        ...screen('division-bank-accounts'),
        loadComponent: () =>
          import('./features/master-data/division-bank-accounts/division-bank-accounts.component').then(
            (m) => m.DivisionBankAccountsComponent,
          ),
        title: 'Division & Bank A/C — Master Data',
      },
      {
        // Client mail item 2, "Hospital Location Master — Addition/Deletion".
        // Admin-only by role: its write routes require role='Admin'.
        path: 'master-data/locations',
        canActivate: [frsAdminGuard],
        loadComponent: () =>
          import('./features/master-data/locations/locations.component').then((m) => m.LocationsComponent),
        title: 'Location Master — Master Data',
      },
      {
        // Admin-only by role: every users.routes.js endpoint requires role='Admin'.
        path: 'master-data/users',
        canActivate: [frsAdminGuard],
        loadComponent: () => import('./features/master-data/users/users.component').then((m) => m.UsersComponent),
        title: 'User Management — Master Data',
      },
      {
        // Whole-application activity log — shown as a tab inside User
        // Management itself, not its own nav entry. Redirects old links.
        path: 'master-data/audit-log',
        redirectTo: 'master-data/users',
        pathMatch: 'full',
      },
      { path: '**', redirectTo: 'dashboard' },
    ],
  },
];
