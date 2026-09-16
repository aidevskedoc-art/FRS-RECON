import { Routes } from '@angular/router';
import { authGuard, loginRedirectGuard, superAdminGuard } from './core/guards/auth.guard';

export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () => import('./features/auth/login/login.component').then((m) => m.LoginComponent),
    canActivate: [loginRedirectGuard],
    title: 'Sign In — FRS - Recon',
  },
  {
    path: '',
    loadComponent: () => import('./layout/shell/shell.component').then((m) => m.ShellComponent),
    canActivate: [authGuard],
    children: [
      // The app opens on the consolidated Reconciliation screen — that is the
      // day-to-day entry point. A non-Super-Admin bounces from there to the
      // insurance dashboard via superAdminGuard, which is outside that guard,
      // so there is no redirect loop.
      { path: '', redirectTo: 'reconciliation', pathMatch: 'full' },
      {
        path: 'insurance-policy/dashboard',
        loadComponent: () =>
          import('./features/insurance-policy/dashboard/dashboard.component').then((m) => m.DashboardComponent),
        title: 'Dashboard — FRS - Recon',
      },
      {
        path: 'insurance-policy/upload',
        loadComponent: () =>
          import('./features/insurance-policy/upload/upload.component').then((m) => m.UploadComponent),
        title: 'Upload — FRS - Recon',
      },
      {
        path: 'insurance-policy/processing',
        loadComponent: () =>
          import('./features/insurance-policy/processing/processing.component').then((m) => m.ProcessingComponent),
        title: 'Processing — FRS - Recon',
      },
      {
        path: 'insurance-policy/documents/:id/processing',
        loadComponent: () =>
          import('./features/insurance-policy/processing/processing.component').then((m) => m.ProcessingComponent),
        title: 'Processing — FRS - Recon',
      },
      {
        path: 'insurance-policy/documents/:id/extraction',
        loadComponent: () =>
          import('./features/insurance-policy/extraction/extraction.component').then((m) => m.ExtractionComponent),
        title: 'Extraction Workspace — FRS - Recon',
      },
      {
        path: 'insurance-policy/documents/:id/validation',
        loadComponent: () =>
          import('./features/insurance-policy/validation/validation.component').then((m) => m.ValidationComponent),
        title: 'Validation Center — FRS - Recon',
      },
      {
        path: 'insurance-policy/documents/:id/review',
        loadComponent: () =>
          import('./features/insurance-policy/review/review.component').then((m) => m.ReviewComponent),
        title: 'Final Review — FRS - Recon',
      },
      {
        path: 'insurance-policy/documents/:id/success',
        loadComponent: () =>
          import('./features/insurance-policy/success/success.component').then((m) => m.SuccessComponent),
        title: 'Saved — FRS - Recon',
      },
      {
        path: 'insurance-policy/excel-preview',
        loadComponent: () =>
          import('./features/insurance-policy/excel-preview/excel-preview.component').then(
            (m) => m.ExcelPreviewComponent,
          ),
        title: 'Excel Preview — FRS - Recon',
      },
      {
        path: 'insurance-policy/history',
        loadComponent: () =>
          import('./features/insurance-policy/history/history.component').then((m) => m.HistoryComponent),
        title: 'Processing History — FRS - Recon',
      },
      {
        // Everything below is outside the Automation Insurance module — Super Admin only.
        path: '',
        canActivate: [superAdminGuard],
        children: [
          {
            path: 'how-to-use',
            loadComponent: () =>
              import('./features/how-to-use/how-to-use.component').then((m) => m.HowToUseComponent),
            title: 'How to Use — FRS - Recon',
          },
          // Upload hubs — superseded by the /reconciliation screen, which
          // uploads every one of these report types itself. Kept as redirects
          // so old links/bookmarks still land somewhere useful.
          { path: 'upload-online/collections', redirectTo: 'reconciliation', pathMatch: 'full' },
          { path: 'upload-online/mis', redirectTo: 'reconciliation', pathMatch: 'full' },
          { path: 'upload-online/bank-feeds', redirectTo: 'reconciliation', pathMatch: 'full' },
          { path: 'upload-online/bank-statement', redirectTo: 'reconciliation', pathMatch: 'full' },
          { path: 'upload-online/payu-mpr-upload', redirectTo: 'reconciliation', pathMatch: 'full' },
          { path: 'upload-online/easebuzz-upload', redirectTo: 'reconciliation', pathMatch: 'full' },
          { path: 'upload-online/ucr-feeds', redirectTo: 'reconciliation', pathMatch: 'full' },
          // Batch/statement list screens — folded into the one tabbed
          // Statements page below.
          { path: 'upload-online/payu-mpr', redirectTo: 'upload-online/statements', pathMatch: 'full' },
          { path: 'upload-online/easebuzz', redirectTo: 'upload-online/statements', pathMatch: 'full' },
          { path: 'upload-online/ucr-batches', redirectTo: 'upload-online/statements', pathMatch: 'full' },
          {
            // Every uploaded-batch list (bank / PayU / EaseBuzz / UPI & Card /
            // IP / Diag OP / cheque / refund) in one place, as tabs.
            path: 'upload-online/statements',
            loadComponent: () =>
              import('./features/upload-online/statements/statements.component').then(
                (m) => m.StatementsComponent,
              ),
            title: 'Statements — FRS Recon',
          },
          // Legacy, off-nav: these two read online_upload_batches, the
          // pre-migration MIS table. POST /api/online-upload/mis now rejects
          // every upload (see online-upload.routes.js), so the table is frozen
          // and these pages exist only to read historical batches by URL.
          {
            path: 'upload-online/payments',
            loadComponent: () =>
              import('./features/upload-online/view-payments/view-payments.component').then(
                (m) => m.ViewPaymentsComponent,
              ),
            title: 'Legacy MIS Batches (Archive) — FRS - Recon',
          },
          {
            path: 'upload-online/payments/:batchId',
            loadComponent: () =>
              import('./features/upload-online/payment-batch-detail/payment-batch-detail.component').then(
                (m) => m.PaymentBatchDetailComponent,
              ),
            title: 'Legacy MIS Batch (Archive) — FRS - Recon',
          },
          { path: 'upload-online/ip-payments', redirectTo: 'upload-online/statements', pathMatch: 'full' },
          {
            path: 'upload-online/ip-payments/:batchId',
            loadComponent: () =>
              import('./features/upload-online/ip-payment-batch-detail/ip-payment-batch-detail.component').then(
                (m) => m.IpPaymentBatchDetailComponent,
              ),
            title: 'IP Payment Batch — Online Payments',
          },
          { path: 'upload-online/diag-op-payments', redirectTo: 'upload-online/statements', pathMatch: 'full' },
          {
            path: 'upload-online/diag-op-payments/:batchId',
            loadComponent: () =>
              import(
                './features/upload-online/diag-op-payment-batch-detail/diag-op-payment-batch-detail.component'
              ).then((m) => m.DiagOpPaymentBatchDetailComponent),
            title: 'Diag OP Payment Batch — Online Payments',
          },
          { path: 'upload-online/cheque-collection', redirectTo: 'reconciliation', pathMatch: 'full' },
          { path: 'upload-online/cheque-collections', redirectTo: 'upload-online/statements', pathMatch: 'full' },
          {
            path: 'upload-online/diag-cheque-collections',
            redirectTo: 'upload-online/statements',
            pathMatch: 'full',
          },
          {
            path: 'upload-online/cheque-collections/:batchId',
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
            loadComponent: () =>
              import(
                './features/upload-online/bank-statement-batch-detail/bank-statement-batch-detail.component'
              ).then((m) => m.BankStatementBatchDetailComponent),
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
          {
            path: 'matched-rules/diagnostics-payment-rules',
            redirectTo: 'matched-rules/results',
            pathMatch: 'full',
          },
          {
            // Every reconciliation result screen (Summary, Audit Report, Unit
            // Matches, PayU/EaseBuzz Settlements, Card/UPI Reconciliation, IP/
            // Diag Payment Rules) in one place, as tabs.
            path: 'matched-rules/results',
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
            loadComponent: () =>
              import('./features/reconciliation/reconciliation.component').then((m) => m.ReconciliationComponent),
            title: 'Reconciliation — FRS Recon',
          },
          // Rule editors — folded into one tabbed Manage Rules page below.
          { path: 'matched-rules/ip-payment-rules/manage', redirectTo: 'matched-rules/manage-rules', pathMatch: 'full' },
          {
            path: 'matched-rules/diagnostics-payment-rules/manage',
            redirectTo: 'matched-rules/manage-rules',
            pathMatch: 'full',
          },
          {
            path: 'matched-rules/cheque-collection-rules/manage',
            redirectTo: 'matched-rules/manage-rules',
            pathMatch: 'full',
          },
          { path: 'matched-rules/gateway-rules/manage', redirectTo: 'matched-rules/manage-rules', pathMatch: 'full' },
          {
            // Every rule editor (IP/Diagnostics/Cheque Matching, Gateway
            // Matching) in one place, as tabs. `?target=` still picks which of
            // the four gateway reconciliations the Gateway tab opens on.
            path: 'matched-rules/manage-rules',
            loadComponent: () =>
              import('./features/matched-rules/manage-rules/manage-rules.component').then(
                (m) => m.ManageRulesComponent,
              ),
            title: 'Manage Rules — Reconciliation',
          },
          {
            path: 'master-data/division-bank-accounts',
            loadComponent: () =>
              import('./features/master-data/division-bank-accounts/division-bank-accounts.component').then(
                (m) => m.DivisionBankAccountsComponent,
              ),
            title: 'Division & Bank A/C — Master Data',
          },
        ],
      },
      { path: '**', redirectTo: 'reconciliation' },
    ],
  },
];
