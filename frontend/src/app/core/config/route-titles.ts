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
  ['/reconciliation', { title: 'Reconciliation', subtitle: 'Upload & run' }],

  ['/insurance-policy/dashboard', { title: 'Dashboard', subtitle: 'Overview' }],
  ['/insurance-policy/upload', { title: 'Upload', subtitle: 'Policy documents' }],
  ['/insurance-policy/processing', { title: 'Processing', subtitle: 'AI extraction' }],
  ['/insurance-policy/excel-preview', { title: 'Excel Export', subtitle: 'Preview' }],
  ['/insurance-policy/history', { title: 'History', subtitle: 'Processed documents' }],
  ['/insurance-policy/documents', { title: 'Document', subtitle: 'Workspace' }],

  // Off-nav archive: the pre-migration online_upload_batches rows. Nothing
  // writes to that table any more, so this is reachable by URL only.
  ['/upload-online/payments', { title: 'Legacy MIS Batches', subtitle: 'Archive' }],

  ['/upload-online/statements', { title: 'Statements', subtitle: 'Batches' }],

  ['/matched-rules/results', { title: 'Reconciliation Results', subtitle: 'Reconciliation' }],

  ['/matched-rules/manage-rules', { title: 'Manage Rules', subtitle: 'Reconciliation' }],

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
