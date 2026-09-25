/**
 * Tests for the combined Mismatch Review export — routes/mismatch-export.routes.js
 * (status resolution) and excel/mismatch-export.js (workbook shape).
 *
 *   node scripts/test-mismatch-export.js
 *
 * The status resolution is what these mostly cover, because it is the part that
 * fails SILENTLY: Online/Cheque take `matchStatus` and Card/UPI take `status`,
 * the two families hold different verdicts, and a filter that does not apply
 * reads to the API as "no filter" — i.e. every row. An export asked for one
 * status would then hand the client the whole ledger without erroring.
 */
require('dotenv').config();

const { statusesFor } = require('../src/routes/mismatch-export.routes');
const { buildMismatchWorkbook } = require('../src/excel/mismatch-export');
const XLSX = require('xlsx');

let pass = 0;
let fail = 0;
const ok = (n, c, e) => {
  if (c) {
    pass++;
    console.log('  PASS ' + n);
  } else {
    fail++;
    console.log('  FAIL ' + n + '  ' + (e === undefined ? '' : JSON.stringify(e)));
  }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('\n=== view mode -> each stream gets its own vocabulary ===');
let r = statusesFor({ mode: 'mismatches' });
ok('mismatches: online gets all four mismatch statuses',
  eq(r.online, ['UNMATCHED', 'AMOUNT_MISMATCH', 'PARTIAL_MATCH', 'AMBIGUOUS_MATCH']), r.online);
ok('mismatches: card/upi get only the two they can hold',
  eq(r.ucr, ['UNMATCHED', 'AMOUNT_MISMATCH']), r.ucr);

r = statusesFor({ mode: 'matched' });
ok('matched: online clean set includes CONTRA_ENTRY and EASEBUZZ_MATCHED',
  r.online.includes('CONTRA_ENTRY') && r.online.includes('EASEBUZZ_MATCHED'), r.online);
ok('matched: card/upi clean set is MATCHED + GROUPED_MATCHED',
  eq(r.ucr, ['MATCHED', 'GROUPED_MATCHED']), r.ucr);

r = statusesFor({ mode: 'all' });
ok('all: null on both sides, meaning no status filter', r.online === null && r.ucr === null, r);

r = statusesFor({});
ok('no mode at all defaults to mismatches, not to everything',
  eq(r.online, ['UNMATCHED', 'AMOUNT_MISMATCH', 'PARTIAL_MATCH', 'AMBIGUOUS_MATCH']), r.online);
r = statusesFor({ mode: 'nonsense' });
ok('an unknown mode falls back to mismatches rather than exporting the ledger',
  eq(r.online, ['UNMATCHED', 'AMOUNT_MISMATCH', 'PARTIAL_MATCH', 'AMBIGUOUS_MATCH']), r.online);

console.log('\n=== a status pick is intersected with each vocabulary (report = Both) ===');
r = statusesFor({ mode: 'all', statuses: 'UNMATCHED' });
ok('UNMATCHED applies to both sides', eq(r.online, ['UNMATCHED']) && eq(r.ucr, ['UNMATCHED']), r);

r = statusesFor({ mode: 'all', statuses: 'CONTRA_ENTRY' });
ok('CONTRA_ENTRY stays on the online/cheque side', eq(r.online, ['CONTRA_ENTRY']), r.online);
ok('CONTRA_ENTRY gives card/upi an EMPTY list, not null', eq(r.ucr, []), r.ucr);
ok('...and empty is NOT null — null would mean "every card row"', r.ucr !== null);

r = statusesFor({ mode: 'all', statuses: 'GROUPED_MATCHED' });
ok('GROUPED_MATCHED applies to card/upi', eq(r.ucr, ['GROUPED_MATCHED']), r.ucr);

r = statusesFor({ mode: 'all', statuses: 'UNMATCHED,CONTRA_ENTRY' });
ok('a mixed pick keeps what each side can hold',
  eq(r.online, ['UNMATCHED', 'CONTRA_ENTRY']) && eq(r.ucr, ['UNMATCHED']), r);

r = statusesFor({ mode: 'all', statuses: ' unmatched , Contra_Entry ' });
ok('case and spacing are normalised', eq(r.online, ['UNMATCHED', 'CONTRA_ENTRY']), r.online);

r = statusesFor({ mode: 'all', statuses: 'NOT_A_STATUS' });
ok('an unknown status filters everything out rather than nothing',
  eq(r.online, []) && eq(r.ucr, []), r);

console.log('\n=== the three reports, and a status pick NARROWING one ===');
ok('Mismatched report', eq(statusesFor({ mode: 'mismatches' }).ucr, ['UNMATCHED', 'AMOUNT_MISMATCH']));
ok('Matched report', eq(statusesFor({ mode: 'matched' }).ucr, ['MATCHED', 'GROUPED_MATCHED']));
ok('Both report', statusesFor({ mode: 'all' }).ucr === null);

r = statusesFor({ mode: 'mismatches', statuses: 'UNMATCHED' });
ok('Mismatched + Unmatched -> just Unmatched', eq(r.online, ['UNMATCHED']) && eq(r.ucr, ['UNMATCHED']), r);

r = statusesFor({ mode: 'matched', statuses: 'UNMATCHED' });
ok('Matched + Unmatched -> nothing, not unmatched rows under a Matched heading',
  eq(r.online, []) && eq(r.ucr, []), r);

r = statusesFor({ mode: 'matched', statuses: 'GROUPED_MATCHED' });
ok('Matched + Grouped Matched -> card/upi only', eq(r.online, []) && eq(r.ucr, ['GROUPED_MATCHED']), r);

r = statusesFor({ mode: 'mismatches', statuses: 'UNMATCHED,CONTRA_ENTRY' });
ok('a status outside the chosen report is dropped, not smuggled in', eq(r.online, ['UNMATCHED']), r.online);

console.log('\n=== an explicit per-stream list still wins (the endpoint stays usable alone) ===');
r = statusesFor({ matchStatus: 'PARTIAL_MATCH', mode: 'all' });
ok('matchStatus overrides mode', eq(r.online, ['PARTIAL_MATCH']), r.online);
r = statusesFor({ statuses: 'UNMATCHED', matchStatus: 'PARTIAL_MATCH' });
ok('matchStatus also wins over statuses', eq(r.online, ['PARTIAL_MATCH']), r.online);

console.log('\n=== workbook shape ===');
const row = (over) => ({
  matchStatus: 'UNMATCHED', matchReason: 'no bank line', onlineUpiAmount: 100, chequeAmount: 100, amount: 100,
  receiptNumber: 'R1', receiptNo: 'R1', locked_at: null, locked_by: null, ...over,
});
let wb = buildMismatchWorkbook({ online: [row()], cheque: [row()], card: [row()], upi: [row()], filterLines: ['View: UNMATCHED'] });
ok('five sheets: a summary plus one per stream', wb.SheetNames.length === 5, wb.SheetNames);
ok('Summary comes first', wb.SheetNames[0] === 'Summary', wb.SheetNames[0]);
ok('sheet names are Excel-legal (no / ? * [ ] :)',
  wb.SheetNames.every((n) => !/[\\/?*[\]:]/.test(n) && n.length <= 31), wb.SheetNames);

let summary = XLSX.utils.sheet_to_json(wb.Sheets.Summary, { header: 1 });
ok('the summary states the filters the file was taken under',
  summary.some((r2) => String(r2[0]).includes('View: UNMATCHED')), summary.slice(0, 6));
ok('the summary totals every stream', summary.some((r2) => r2[0] === 'Total' && r2[1] === 4), summary);

let online = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[1]]);
ok('every row carries its Reason — the point of the file', online[0].Reason === 'no bank line', online[0]);
ok('Status is the client-facing wording, not the engine constant',
  online[0].Status === 'Unmatched', online[0].Status);

wb = buildMismatchWorkbook({ online: [], cheque: [], card: [], upi: [], filterLines: [] });
ok('an empty stream still gets a sheet (absence must not read as "not exported")',
  wb.SheetNames.length === 5, wb.SheetNames);
const empty = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[1]], { header: 1 });
ok('...and says so in words', String(empty[1][0]).includes('nothing in this view'), empty[1]);

summary = XLSX.utils.sheet_to_json(
  buildMismatchWorkbook({ online: [row()], cheque: [row()], card: [row()], upi: [row()] }).Sheets.Summary, { header: 1 },
);
ok('the Online value is summed (it read a missing field and showed 0)', summary.some((r2) => String(r2[0]).startsWith('Online') && r2[2] === 100), summary);
ok('"Generated" is stamped in IST', String(summary[1][0]).endsWith(' IST'), summary[1]);

// ---- every column against the rows the export REALLY loads (read-only) ----
// A column that reads a field name the mappers don't produce is silently blank:
// 2026-09-25 that was Online Amount (so the Online value was 0), the four Online
// group columns and Card/UPI Settled Amount. Checked against real data, not a
// hand-built row, because a hand-built row just repeats the same wrong name.
(async () => {
  const { ONLINE_COLUMNS, CHEQUE_COLUMNS, UCR_COLUMNS } = require('../src/excel/mismatch-export');
  const { loaders } = require('../src/routes/mismatch-export.routes');
  const propsOf = (c) => (String(c.get).match(/r\.([a-zA-Z0-9_]+)/g) || []).map((x) => x.slice(2));
  console.log('\n=== every sheet column reads a field the real rows carry ===');
  const streams = [
    ['Online', () => loaders.loadOnline({}), ONLINE_COLUMNS],
    ['Cheque', () => loaders.loadCheque({}), CHEQUE_COLUMNS],
    ['Card', () => loaders.loadUcr('CARD', {}), UCR_COLUMNS],
    ['UPI', () => loaders.loadUcr('UPI', {}), UCR_COLUMNS],
  ];
  for (const [name, load, cols] of streams) {
    const rows = await load();
    if (!rows.length) {
      console.log(`  SKIP ${name}: no rows in this database to check against`);
      continue;
    }
    const keys = new Set(rows.flatMap((r) => Object.keys(r)));
    const missing = cols.filter((c) => propsOf(c).length && propsOf(c).every((p) => !keys.has(p))).map((c) => `${c.label} (${propsOf(c)})`);
    ok(`${name}: no column reads a missing field`, missing.length === 0, missing);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
