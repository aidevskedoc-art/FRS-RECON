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
            path: 'upload-online/mis',
            loadComponent: () =>
              import('./features/upload-online/upload-mis/upload-mis.component').then((m) => m.UploadMisComponent),
            title: 'Upload MIS Data — Upload Online',
          },
          {
            path: 'upload-online/bank-statement',
            loadComponent: () =>
              import('./features/upload-online/upload-bank-statement/upload-bank-statement.component').then(
                (m) => m.UploadBankStatementComponent,
              ),
            title: 'Upload Bank Statement — Upload Online',
          },
          {
            path: 'upload-online/payments',
            loadComponent: () =>
              import('./features/upload-online/view-payments/view-payments.component').then(
                (m) => m.ViewPaymentsComponent,
              ),
            title: 'IP & Diag Payments — Upload Online',
          },
          {
            path: 'upload-online/payments/:batchId',
            loadComponent: () =>
              import('./features/upload-online/payment-batch-detail/payment-batch-detail.component').then(
                (m) => m.PaymentBatchDetailComponent,
              ),
            title: 'Payment Batch — Upload Online',
          },
          {
            path: 'upload-online/ip-payments',
            loadComponent: () =>
              import('./features/upload-online/view-ip-payments/view-ip-payments.component').then(
                (m) => m.ViewIpPaymentsComponent,
              ),
            title: 'New Online Payments — Upload Online',
          },
          {
            path: 'upload-online/ip-payments/:batchId',
            loadComponent: () =>
              import('./features/upload-online/ip-payment-batch-detail/ip-payment-batch-detail.component').then(
                (m) => m.IpPaymentBatchDetailComponent,
              ),
            title: 'IP Payment Batch — Upload Online',
          },
          {
            path: 'upload-online/diag-op-payments',
            loadComponent: () =>
              import('./features/upload-online/view-diag-op-payments/view-diag-op-payments.component').then(
                (m) => m.ViewDiagOpPaymentsComponent,
              ),
            title: 'Diag OP Payments — Upload Online',
          },
          {
            path: 'upload-online/diag-op-payments/:batchId',
            loadComponent: () =>
              import(
                './features/upload-online/diag-op-payment-batch-detail/diag-op-payment-batch-detail.component'
              ).then((m) => m.DiagOpPaymentBatchDetailComponent),
            title: 'Diag OP Payment Batch — Upload Online',
          },
          {
            path: 'upload-online/bank-statements',
            loadComponent: () =>
              import('./features/upload-online/view-bank-statements/view-bank-statements.component').then(
                (m) => m.ViewBankStatementsComponent,
              ),
            title: 'Bank Statements — Upload Online',
          },
          {
            path: 'upload-online/bank-statements/:batchId',
            loadComponent: () =>
              import(
                './features/upload-online/bank-statement-batch-detail/bank-statement-batch-detail.component'
              ).then((m) => m.BankStatementBatchDetailComponent),
            title: 'Bank Statement Transactions — Upload Online',
          },
          {
            path: 'matched-rules/summary',
            loadComponent: () =>
              import('./features/matched-rules/reconciliation-summary/reconciliation-summary.component').then(
                (m) => m.ReconciliationSummaryComponent,
              ),
            title: 'Reconciliation Summary — Matched Rules',
          },
          {
            path: 'matched-rules/ip-payment-rules',
            loadComponent: () =>
              import('./features/matched-rules/ip-payment-rules/ip-payment-rules.component').then(
                (m) => m.IpPaymentRulesComponent,
              ),
            title: 'IP Payment Rules — Matched Rules',
          },
          {
            path: 'matched-rules/diagnostics-payment-rules',
            loadComponent: () =>
              import('./features/matched-rules/diag-payment-rules/diag-payment-rules.component').then(
                (m) => m.DiagPaymentRulesComponent,
              ),
            title: 'Diagnostics Payment Rules — Matched Rules',
          },
          {
            path: 'matched-rules/ip-payment-rules/manage',
            loadComponent: () =>
              import('./features/matched-rules/ip-matching-rules/ip-matching-rules.component').then(
                (m) => m.IpMatchingRulesComponent,
              ),
            title: 'IP Payment Matching Rules — Master Rules',
          },
          {
            path: 'matched-rules/diagnostics-payment-rules/manage',
            loadComponent: () =>
              import('./features/matched-rules/diag-matching-rules/diag-matching-rules.component').then(
                (m) => m.DiagMatchingRulesComponent,
              ),
            title: 'Diagnostics Payment Matching Rules — Master Rules',
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
