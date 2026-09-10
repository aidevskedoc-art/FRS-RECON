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

  ['/upload-online/mis', { title: 'Upload MIS Data', subtitle: 'Online payments' }],
  ['/upload-online/ip-payments', { title: 'IP Payments', subtitle: 'Batches' }],
  ['/upload-online/diag-op-payments', { title: 'Diag OP Payments', subtitle: 'Batches' }],

  ['/upload-online/bank-statement', { title: 'Upload Bank Statement', subtitle: 'Bank & PayU' }],
  ['/upload-online/bank-statements', { title: 'Bank Statements', subtitle: 'Batches' }],
  ['/upload-online/payu-mpr-upload', { title: 'Upload PayU MPR', subtitle: 'Bank & PayU' }],
  ['/upload-online/payu-mpr', { title: 'PayU MPR', subtitle: 'Batches' }],
  ['/upload-online/easebuzz-upload', { title: 'Upload EaseBuzz', subtitle: 'Bank & PayU' }],
  ['/upload-online/easebuzz', { title: 'EaseBuzz', subtitle: 'Batches' }],

  // Off-nav archive: the pre-migration online_upload_batches rows. Nothing
  // writes to that table any more, so this is reachable by URL only.
  ['/upload-online/payments', { title: 'Legacy MIS Batches', subtitle: 'Archive' }],

  ['/upload-online/cheque-collection', { title: 'Upload Cheque Collection', subtitle: 'Cheque & refunds' }],
  ['/upload-online/cheque-collections', { title: 'IP Cheque Collections', subtitle: 'Batches' }],
  ['/upload-online/diag-cheque-collections', { title: 'Diagnostics Cheque Collections', subtitle: 'Batches' }],
  ['/upload-online/refund-document', { title: 'Upload Refund Document', subtitle: 'Cheque & refunds' }],
  ['/upload-online/refund-documents', { title: 'Refund Documents', subtitle: 'Reference data' }],

  ['/matched-rules/summary', { title: 'Reconciliation', subtitle: 'Summary' }],
  ['/matched-rules/audit-report', { title: 'Audit Working Report', subtitle: 'Reconciliation' }],
  ['/matched-rules/unit-matches', { title: 'Unit Matches', subtitle: 'Matched' }],
  ['/matched-rules/payu-settlements', { title: 'PayU Settlements', subtitle: 'Matched' }],
  ['/matched-rules/ip-payment-rules/manage', { title: 'Matching Rules', subtitle: 'IP payments' }],
  ['/matched-rules/ip-payment-rules', { title: 'IP Payment Rules', subtitle: 'Matched' }],
  [
    '/matched-rules/diagnostics-payment-rules/manage',
    { title: 'Matching Rules', subtitle: 'Diagnostics' },
  ],
  ['/matched-rules/diagnostics-payment-rules', { title: 'Diagnostics Payment Rules', subtitle: 'Matched' }],

  ['/matched-rules/cheque-collection-rules/manage', { title: 'Matching Rules', subtitle: 'Cheque collection' }],

  ['/master-data/division-bank-accounts', { title: 'Division & Bank A/C', subtitle: 'Master data' }],

  ['/how-to-use', { title: 'How to Use', subtitle: 'Reconciliation guide' }],
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
