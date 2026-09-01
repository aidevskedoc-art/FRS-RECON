/**
 * The topbar's route title map.
 *
 * One ordered prefix → {title, subtitle} table, resolved longest-prefix-first
 * so a child route ('/matched-rules/ip-payment-rules/manage') can override its
 * parent ('/matched-rules/ip-payment-rules') without the table needing to be
 * hand-ordered. The subtitle renders as `· Subtitle` in gradient text.
 *
 * This is deliberately separate from the `title:` fields on the routes
 * themselves: those set document.title (and read as "Page — App"), while these
 * are the on-screen masthead labels.
 */
export interface RouteTitle {
  readonly title: string;
  readonly subtitle: string;
}

const ROUTE_TITLES: ReadonlyArray<readonly [string, RouteTitle]> = [
  ['/insurance-policy/dashboard', { title: 'Dashboard', subtitle: 'Overview' }],
  ['/insurance-policy/upload', { title: 'Upload', subtitle: 'Policy documents' }],
  ['/insurance-policy/processing', { title: 'Processing', subtitle: 'AI extraction' }],
  ['/insurance-policy/excel-preview', { title: 'Excel Export', subtitle: 'Preview' }],
  ['/insurance-policy/history', { title: 'History', subtitle: 'Processed documents' }],
  ['/insurance-policy/documents', { title: 'Document', subtitle: 'Workspace' }],

  ['/upload-online/mis', { title: 'MIS Upload', subtitle: 'Online data' }],
  ['/upload-online/bank-statements', { title: 'Bank Statements', subtitle: 'Transactions' }],
  ['/upload-online/bank-statement', { title: 'Bank Statement', subtitle: 'Upload' }],
  ['/upload-online/ip-payments', { title: 'Online Payments', subtitle: 'In-patient' }],
  ['/upload-online/diag-op-payments', { title: 'Diag OP Payments', subtitle: 'Outpatient' }],
  ['/upload-online/payments', { title: 'Payments', subtitle: 'IP & Diagnostics' }],

  ['/matched-rules/summary', { title: 'Reconciliation', subtitle: 'Summary' }],
  ['/matched-rules/unit-matches', { title: 'Unit Matches', subtitle: 'Matched' }],
  ['/matched-rules/ip-payment-rules/manage', { title: 'Matching Rules', subtitle: 'IP payments' }],
  ['/matched-rules/ip-payment-rules', { title: 'IP Payment Rules', subtitle: 'Matched' }],
  [
    '/matched-rules/diagnostics-payment-rules/manage',
    { title: 'Matching Rules', subtitle: 'Diagnostics' },
  ],
  ['/matched-rules/diagnostics-payment-rules', { title: 'Diagnostics Rules', subtitle: 'Matched' }],

  ['/master-data/division-bank-accounts', { title: 'Division & Bank A/C', subtitle: 'Master data' }],
];

const FALLBACK: RouteTitle = { title: 'FRS Recon', subtitle: 'Workspace' };

/** Longest matching prefix wins; query strings and fragments are ignored. */
export function resolveRouteTitle(url: string): RouteTitle {
  const path = url.split('?')[0].split('#')[0];
  let best: RouteTitle | null = null;
  let bestLength = -1;

  for (const [prefix, title] of ROUTE_TITLES) {
    if (path.startsWith(prefix) && prefix.length > bestLength) {
      best = title;
      bestLength = prefix.length;
    }
  }

  return best ?? FALLBACK;
}
