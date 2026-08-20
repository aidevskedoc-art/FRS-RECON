import { Routes } from '@angular/router';
import { authGuard, loginRedirectGuard } from './core/guards/auth.guard';

export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () => import('./features/auth/login/login.component').then((m) => m.LoginComponent),
    canActivate: [loginRedirectGuard],
    title: 'Sign In — Insurance Policy Intelligence',
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
        title: 'Dashboard — Insurance Policy Intelligence',
      },
      {
        path: 'insurance-policy/upload',
        loadComponent: () =>
          import('./features/insurance-policy/upload/upload.component').then((m) => m.UploadComponent),
        title: 'Upload — Insurance Policy Intelligence',
      },
      {
        path: 'insurance-policy/processing',
        loadComponent: () =>
          import('./features/insurance-policy/processing/processing.component').then((m) => m.ProcessingComponent),
        title: 'Processing — Insurance Policy Intelligence',
      },
      {
        path: 'insurance-policy/documents/:id/processing',
        loadComponent: () =>
          import('./features/insurance-policy/processing/processing.component').then((m) => m.ProcessingComponent),
        title: 'Processing — Insurance Policy Intelligence',
      },
      {
        path: 'insurance-policy/documents/:id/extraction',
        loadComponent: () =>
          import('./features/insurance-policy/extraction/extraction.component').then((m) => m.ExtractionComponent),
        title: 'Extraction Workspace — Insurance Policy Intelligence',
      },
      {
        path: 'insurance-policy/documents/:id/validation',
        loadComponent: () =>
          import('./features/insurance-policy/validation/validation.component').then((m) => m.ValidationComponent),
        title: 'Validation Center — Insurance Policy Intelligence',
      },
      {
        path: 'insurance-policy/documents/:id/review',
        loadComponent: () =>
          import('./features/insurance-policy/review/review.component').then((m) => m.ReviewComponent),
        title: 'Final Review — Insurance Policy Intelligence',
      },
      {
        path: 'insurance-policy/documents/:id/success',
        loadComponent: () =>
          import('./features/insurance-policy/success/success.component').then((m) => m.SuccessComponent),
        title: 'Saved — Insurance Policy Intelligence',
      },
      {
        path: 'insurance-policy/excel-preview',
        loadComponent: () =>
          import('./features/insurance-policy/excel-preview/excel-preview.component').then(
            (m) => m.ExcelPreviewComponent,
          ),
        title: 'Excel Preview — Insurance Policy Intelligence',
      },
      {
        path: 'insurance-policy/history',
        loadComponent: () =>
          import('./features/insurance-policy/history/history.component').then((m) => m.HistoryComponent),
        title: 'Processing History — Insurance Policy Intelligence',
      },
      { path: '**', redirectTo: 'insurance-policy/dashboard' },
    ],
  },
];
