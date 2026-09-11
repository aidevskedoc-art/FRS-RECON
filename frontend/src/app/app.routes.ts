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
      { path: '', redirectTo: 'insurance-policy/dashboard', pathMatch: 'full' },
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
          {
            // One screen for every collection-side report (MIS / cheque /
            // refund). The three standalone upload paths below redirect here.
            path: 'upload-online/collections',
            loadComponent: () =>
              import('./features/upload-online/upload-collections/upload-collections.component').then(
                (m) => m.UploadCollectionsComponent,
              ),
            title: 'Upload Collection Reports — Online Payments',
          },
          { path: 'upload-online/mis', redirectTo: 'upload-online/collections', pathMatch: 'full' },
          {
            // One screen for every bank-side feed (bank statement / PayU MPR /
            // EaseBuzz). The three standalone upload paths below redirect here.
            path: 'upload-online/bank-feeds',
            loadComponent: () =>
              import('./features/upload-online/upload-bank-feeds/upload-bank-feeds.component').then(
                (m) => m.UploadBankFeedsComponent,
              ),
            title: 'Upload Bank & Gateway Feeds — Bank & PayU',
          },
          { path: 'upload-online/bank-statement', redirectTo: 'upload-online/bank-feeds', pathMatch: 'full' },
          { path: 'upload-online/payu-mpr-upload', redirectTo: 'upload-online/bank-feeds', pathMatch: 'full' },
          {
            path: 'upload-online/payu-mpr',
            loadComponent: () =>
              import('./features/upload-online/view-payu-mpr/view-payu-mpr.component').then(
                (m) => m.ViewPayuMprComponent,
              ),
            title: 'PayU MPR Batches — Bank & PayU',
          },
          { path: 'upload-online/easebuzz-upload', redirectTo: 'upload-online/bank-feeds', pathMatch: 'full' },
          {
            path: 'upload-online/easebuzz',
            loadComponent: () =>
              import('./features/upload-online/view-easebuzz/view-easebuzz.component').then(
                (m) => m.ViewEasebuzzComponent,
              ),
            title: 'EaseBuzz Batches — Bank & PayU',
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
          {
            path: 'upload-online/ip-payments',
            loadComponent: () =>
              import('./features/upload-online/view-ip-payments/view-ip-payments.component').then(
                (m) => m.ViewIpPaymentsComponent,
              ),
            title: 'IP Payments — Online Payments',
          },
          {
            path: 'upload-online/ip-payments/:batchId',
            loadComponent: () =>
              import('./features/upload-online/ip-payment-batch-detail/ip-payment-batch-detail.component').then(
                (m) => m.IpPaymentBatchDetailComponent,
              ),
            title: 'IP Payment Batch — Online Payments',
          },
          {
            path: 'upload-online/diag-op-payments',
            loadComponent: () =>
              import('./features/upload-online/view-diag-op-payments/view-diag-op-payments.component').then(
                (m) => m.ViewDiagOpPaymentsComponent,
              ),
            title: 'Diag OP Payments — Online Payments',
          },
          {
            path: 'upload-online/diag-op-payments/:batchId',
            loadComponent: () =>
              import(
                './features/upload-online/diag-op-payment-batch-detail/diag-op-payment-batch-detail.component'
              ).then((m) => m.DiagOpPaymentBatchDetailComponent),
            title: 'Diag OP Payment Batch — Online Payments',
          },
          { path: 'upload-online/cheque-collection', redirectTo: 'upload-online/collections', pathMatch: 'full' },
          {
            // One component, two screens. `collectionKind` is the only thing
            // that differs, so it is route data rather than a second component.
            path: 'upload-online/cheque-collections',
            loadComponent: () =>
              import('./features/upload-online/view-cheque-collections/view-cheque-collections.component').then(
                (m) => m.ViewChequeCollectionsComponent,
              ),
            data: { collectionKind: 'IP' },
            title: 'IP Cheque Collections — Cheque & Refunds',
          },
          {
            path: 'upload-online/diag-cheque-collections',
            loadComponent: () =>
              import('./features/upload-online/view-cheque-collections/view-cheque-collections.component').then(
                (m) => m.ViewChequeCollectionsComponent,
              ),
            data: { collectionKind: 'OP' },
            title: 'Diagnostics Cheque Collections — Cheque & Refunds',
          },
          {
            path: 'upload-online/cheque-collections/:batchId',
            loadComponent: () =>
              import(
                './features/upload-online/cheque-collection-batch-detail/cheque-collection-batch-detail.component'
              ).then((m) => m.ChequeCollectionBatchDetailComponent),
            title: 'Cheque Collection Batch — Cheque & Refunds',
          },
          { path: 'upload-online/refund-document', redirectTo: 'upload-online/collections', pathMatch: 'full' },
          {
            path: 'upload-online/refund-documents',
            loadComponent: () =>
              import('./features/upload-online/view-refund-documents/view-refund-documents.component').then(
                (m) => m.ViewRefundDocumentsComponent,
              ),
            title: 'Refund Documents — Cheque & Refunds',
          },
          {
            path: 'upload-online/bank-statements',
            loadComponent: () =>
              import('./features/upload-online/view-bank-statements/view-bank-statements.component').then(
                (m) => m.ViewBankStatementsComponent,
              ),
            title: 'Bank Statements — Bank & PayU',
          },
          {
            path: 'upload-online/bank-statements/:batchId',
            loadComponent: () =>
              import(
                './features/upload-online/bank-statement-batch-detail/bank-statement-batch-detail.component'
              ).then((m) => m.BankStatementBatchDetailComponent),
            title: 'Bank Statement Transactions — Bank & PayU',
          },
          {
            path: 'matched-rules/summary',
            loadComponent: () =>
              import('./features/matched-rules/reconciliation-summary/reconciliation-summary.component').then(
                (m) => m.ReconciliationSummaryComponent,
              ),
            title: 'Reconciliation Summary — Reconciliation',
          },
          {
            path: 'matched-rules/unit-matches',
            loadComponent: () =>
              import('./features/matched-rules/unit-matches/unit-matches.component').then(
                (m) => m.UnitMatchesComponent,
              ),
            title: 'Unit Matches — Reconciliation',
          },
          {
            path: 'matched-rules/payu-settlements',
            loadComponent: () =>
              import('./features/matched-rules/payu-settlements/payu-settlements.component').then(
                (m) => m.PayuSettlementsComponent,
              ),
            title: 'PayU Settlements — Reconciliation',
          },
          {
            path: 'matched-rules/audit-report',
            loadComponent: () =>
              import('./features/matched-rules/audit-report/audit-report.component').then((m) => m.AuditReportComponent),
            title: 'Audit Working Report — Reconciliation',
          },
          {
            path: 'matched-rules/ip-payment-rules',
            loadComponent: () =>
              import('./features/matched-rules/ip-payment-rules/ip-payment-rules.component').then(
                (m) => m.IpPaymentRulesComponent,
              ),
            title: 'IP Payment Rules — Reconciliation',
          },
          {
            path: 'matched-rules/diagnostics-payment-rules',
            loadComponent: () =>
              import('./features/matched-rules/diag-payment-rules/diag-payment-rules.component').then(
                (m) => m.DiagPaymentRulesComponent,
              ),
            title: 'Diagnostics Payment Rules — Reconciliation',
          },
          {
            path: 'matched-rules/ip-payment-rules/manage',
            loadComponent: () =>
              import('./features/matched-rules/ip-matching-rules/ip-matching-rules.component').then(
                (m) => m.IpMatchingRulesComponent,
              ),
            title: 'IP Matching Rules — Reconciliation',
          },
          {
            path: 'matched-rules/diagnostics-payment-rules/manage',
            loadComponent: () =>
              import('./features/matched-rules/diag-matching-rules/diag-matching-rules.component').then(
                (m) => m.DiagMatchingRulesComponent,
              ),
            title: 'Diagnostics Matching Rules — Reconciliation',
          },
          {
            // Off-nav, like the other rule editors: reached from the Manage
            // Rules button on the batch it configures, so configuring a rule
            // never means leaving the section you are standing in.
            path: 'matched-rules/cheque-collection-rules/manage',
            loadComponent: () =>
              import('./features/matched-rules/cheque-matching-rules/cheque-matching-rules.component').then(
                (m) => m.ChequeMatchingRulesComponent,
              ),
            title: 'Cheque Matching Rules — Reconciliation',
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
      { path: '**', redirectTo: 'insurance-policy/dashboard' },
    ],
  },
];
