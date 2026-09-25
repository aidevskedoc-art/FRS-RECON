/**
 * The one store/skip rule shared by the manual Upload & Run screen and the
 * folder scheduler (src/online-upload/upload-decision.js), plus proof that the
 * manual screen's detect route hands the screen exactly that decision.
 * Read-only against the DB (the detect route only checks for stored rows).
 *   node scripts/test-upload-decision.js
 */
require('dotenv').config();
const { decideReport, decideFile } = require('../src/online-upload/upload-decision');
const detectRouter = require('../src/routes/uploads-detect.routes');
const { combinedWorkbook, toBuffer } = require('./fixtures/his-workbook');

let pass = 0, fail = 0;
const check = (label, cond) => { if (cond) { pass++; console.log(`  ok   ${label}`); } else { fail++; console.log(`  FAIL ${label}`); } };

const base = (over = {}) => ({
  status: 'VERIFIED', sheets: [], ingest: { rows: 10 }, overlap: null, alreadyStored: null, heldBack: [], notes: [], ...over,
});

(async () => {
  // ---- decideReport -------------------------------------------------------
  check('clean -> STORE, no warnings', decideReport(base()).action === 'STORE' && decideReport(base()).warnings.length === 0);
  check('no preview -> STORE', decideReport(undefined).action === 'STORE');

  const failed = decideReport(base({ status: 'FAILED', sheets: [{ sheetName: 'S1', problems: [{ severity: 'error', message: 'totals differ' }] }] }));
  check('FAILED -> SKIP, reason names the problem', failed.action === 'SKIP' && /totals differ/.test(failed.message));

  check('nothing to store -> SKIPPED_EMPTY', decideReport(base({ ingest: { rows: 0 } })).outcome === 'SKIPPED_EMPTY');
  check('all rows already stored (MIS) -> SKIPPED_DUPLICATE', decideReport(base({ ingest: { rows: 0 }, alreadyStored: { rows: 5 } })).outcome === 'SKIPPED_DUPLICATE');
  const partial = decideReport(base({ ingest: { rows: 6 }, alreadyStored: { rows: 4 } }));
  check('some rows already stored (overlapping period) -> STORE the new ones, skipped count shown', partial.action === 'STORE' && /4 row\(s\) already stored.*6 new/.test(partial.message));

  const held = decideReport(base({ heldBack: [{ receiptNo: 'ORE1', amount: 99, reason: 'split UPI/ManualUPI' }] }));
  const split = decideReport(base({ splitPaid: [{ receiptNo: 'ORE2', amount: 50, reason: 'paid in two UPI parts' }] }));
  check('split-paid receipts -> STORE, listed as a warning', split.action === 'STORE' && /ORE2/.test(split.message) && /Unmatched/.test(split.message));
  check('held-back receipts -> STORE, receipts listed as a warning', held.action === 'STORE' && /ORE1/.test(held.message));
  const unver = decideReport(base({ status: 'UNVERIFIED' }));
  check('totals not checkable -> STORE with a warning', unver.action === 'STORE' && unver.warnings.length === 1);
  const warn = decideReport(base({ sheets: [{ sheetName: 'S1', problems: [{ severity: 'warning', message: 'odd row' }] }] }));
  check('sheet warning -> STORE with the warning', warn.action === 'STORE' && /odd row/.test(warn.message));

  // ---- decideFile ---------------------------------------------------------
  const plain = [{ type: 'BANK_STATEMENT', label: 'Bank', confidence: 95 }, { type: 'PAYU_MPR', label: 'PayU', confidence: 40 }];
  const sure = decideFile(plain, true);
  check('single-report file, certain -> best match stored only', !sure.needsType && sure.decisions.length === 1 && sure.decisions[0].type === 'BANK_STATEMENT' && sure.decisions[0].action === 'STORE');
  const unsure = decideFile(plain, false);
  check('single-report file, uncertain -> a person picks the type', unsure.needsType && unsure.decisions[0].action === 'SKIP');
  check('unrecognised -> a person picks the type', decideFile([], false).needsType);
  const his = decideFile([
    { type: 'MIS_IP', label: 'MIS IP', confidence: 90, preview: base() },
    { type: 'UCR_DIAG', label: 'UCR Diag', confidence: 90, preview: base({ ingest: { rows: 0 } }) },
    { type: 'REFUND', label: 'Refund', confidence: 30 },
  ], false);
  check('HIS workbook -> no type question, each report decided on its own',
    !his.needsType && his.decisions.map((d) => d.action).join() === 'STORE,SKIP,SKIP');

  // ---- the manual screen's detect route carries the same decision --------
  const layer = detectRouter.stack.find((l) => l.route && l.route.path === '/detect' && l.route.methods.post);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const buffer = toBuffer(combinedWorkbook());
  let body;
  await handler(
    { files: [{ buffer, originalname: 'ZZ-combined.xlsx', size: buffer.length }], body: {}, query: {}, headers: {} },
    { status() { return this; }, json(p) { body = p; return this; } },
    (err) => { if (err) throw err; },
  );
  const result = body.results[0];
  const all = [result.detected, ...result.alternatives];
  check('detect: combined workbook needs no type question', result.certain === true);
  check('detect: every report carries a decision', all.every((m) => m.decision && ['STORE', 'SKIP'].includes(m.decision.action)));
  const diag = all.find((m) => m.type === 'MIS_DIAG');
  check('detect: MIS_DIAG with a split-paid receipt is STORE, and says so (as the scheduler does)', diag?.decision.action === 'STORE' && /two UPI parts.*shown as Unmatched/.test(diag.decision.message || ''));
  const expected = decideFile(all.map(({ decision, ...m }) => m), true).decisions;
  check('detect: decisions identical to decideFile on the same matches (the scheduler’s call)',
    JSON.stringify(all.map((m) => m.decision)) === JSON.stringify(all.map((m) => expected.find((d) => d.type === m.type))));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
