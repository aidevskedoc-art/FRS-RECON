/**
 * The client's deliverable: the "AUDIT WORKING REPORT" workbook — one sheet per
 * collection stream, each a MIS row joined to its reconciliation verdict, laid
 * out exactly as the auditor assembles it by hand today. The sample at
 * `C:\Users\ED9046\Downloads\FRS\AUDIT WORKING REPORT  -JUL-26 (1).xlsx` is the
 * source of truth for the sheet set, the SUMMARY / OBJECTIVE / Total preamble
 * block, column headers and order, the EFT-NO = matched-bank-narration
 * convention, the status vocabulary in DATE OF REALIZATION / REALIZATION
 * AMOUNT / REMARKS, and the Excel number/date CELL FORMATS.
 *
 * Sheet scope (from the sample):
 *   ONLINE COLLECTION       — IP online, bank-transfer instruments only
 *                             (NEFT/IMPS/RTGS/BHIM/wallet). Gateway-UPI receipts
 *                             reconcile through the PayU settlement path, not
 *                             here, so payment_mode 'UPI' / 'ManualUPI' is left out.
 *   ONLINE DIAG COLLECTION  — the "video collection" subset (see plan; the exact
 *                             predicate is still with the client).
 *   CHEQUE COLL AND REALIZN — cheque collections + the contra / refund pass.
 *
 * The sample also carries a WEB CONSULTATIONS sheet (tele / web consultation +
 * health-checkup payments). The client asked for it to be dropped — it duplicates
 * data already covered elsewhere — so it is no longer emitted.
 *
 * Pure: handed already-merged `{ ...mappedRecord, __result, __seq }` rows and a
 * period label, it returns an xlsx workbook object. The route does the DB work.
 */

const XLSX = require('xlsx');
const { MONTHS_SHORT } = require('../reconciliation/period');

const MONTHS_TITLE = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Excel cell number formats, lifted verbatim from the sample so a cell renders
// identically: accounting (comma thousands, "-" for zero) for amounts, the
// bracketed-negative accounting variant for the difference column, dd/mmm/yy
// for real dates.
const FMT_ACCT = '_ * #,##0_ ;_ * \\-#,##0_ ;_ * "-"??_ ;_ @_ ';
const FMT_ACCT_PAREN = '_(* #,##0_);_(* \\(#,##0\\);_(* "-"??_);_(@_)';
const FMT_DATE = 'dd/mmm/yy';

/** Each location's fixed reviewer, from the sample's NAME OF THE AUDITOR column. */
const AUDITOR_BY_LOCATION = {
  SOMAJIGUDA: 'MRS.ANUSHA T',
  SECUNDERABAD: 'RAMANJANEYULU T',
  MALAKPET: 'Mr.SIVA GANGADHAR',
  'HITECH CITY': 'MR.RAVI.K',
  'HITEC CITY': 'MR.RAVI.K',
};

/** 'YYYY-MM-DD' -> Excel serial day number (1900 date system), or null. */
function excelSerial(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Math.round((ms - Date.UTC(1899, 11, 30)) / 86400000);
}

/** 'YYYY-MM-DD' (or any ISO prefix) -> 'DD/Mon/YY'. Passes blank / unparseable through. Kept for the unit tests and any text-date use. */
function fmtDate(value) {
  if (!value) return '';
  const s = String(value).slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(value);
  return `${m[3]}/${MONTHS_TITLE[Number(m[2]) - 1]}/${m[1].slice(2)}`;
}

/** A receipt date -> the sample's MONTH cell text, e.g. "JUL'26". Blank when the date is missing. */
function monthCell(value) {
  const s = String(value || '').slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-\d{2}$/);
  if (!m) return '';
  return `${MONTHS_SHORT[Number(m[2]) - 1]}'${m[1].slice(2)}`;
}

/** BANK ACCOUNT NO. — the last 4 digits as a number ("7777", "771"), matching the sample. Blank when absent. */
function bankAccountShort(accountNo) {
  const digits = String(accountNo || '').replace(/\D/g, '');
  if (!digits) return '';
  const last4 = digits.slice(-4).replace(/^0+/, '');
  return last4 === '' ? 0 : Number(last4);
}

/** Every transaction reference the MIS row carries, full length, de-duplicated, comma-joined — the sample keeps the auditor's suffixed forms ("...752a,...850"). */
function txnIdCell(record) {
  const refs = [record.transactionRef1, record.transId, record.transactionRef2, record.transactionRef3]
    .map((v) => (v == null ? '' : String(v).trim()))
    .filter(Boolean);
  return [...new Set(refs)].join(',');
}

// A verdict that carries a real bank counterpart (and therefore a realization
// date). CONTRA_ENTRY and UNMATCHED / AMBIGUOUS_MATCH are handled apart.
const BANK_DATE_STATUSES = new Set(['MATCHED', 'PARTIAL_MATCH', 'EASEBUZZ_MATCHED', 'AMOUNT_MISMATCH']);

/**
 * DATE OF REALIZATION — either a real bank date ('YYYY-MM-DD', the workbook
 * builder turns it into a formatted Excel date) or one of the sample's literal
 * labels. A CONTRA_ENTRY reads "CREDIT CONTRA ENTRY" unless the contra rule has
 * stamped a different label onto the verdict (`contra.realizationLabel`).
 */
function realizationCell(result) {
  if (!result || result.excluded) return '';
  if (result.status === 'CONTRA_ENTRY') return (result.contra && result.contra.realizationLabel) || 'CREDIT CONTRA ENTRY';
  if (BANK_DATE_STATUSES.has(result.status)) {
    const d = result.bank && result.bank.txnDate;
    return d ? String(d).slice(0, 10) : '';
  }
  return '';
}

/** A receipt matched against a shared pool — a split-payment unit, or an international bill drawn from one bulk inward remittance. Its realized figure is its own amount, not the pool total. */
function isPooledMatch(result) {
  if (result.unitCount && result.unitCount > 1) return true;
  return /inward remittance/i.test(result.appliedRuleName || '');
}

/**
 * REALIZATION AMOUNT. For a plain 1:1 match it is the bank credit; for a match
 * against a shared pool (a split-payment unit, or an international bill drawn
 * from one bulk inward remittance) the sample puts the row's OWN MIS amount
 * here and notes it in REMARKS, so DIFFERENCE stays 0 per row. Blank for a
 * contra or anything unmatched.
 */
function realizationAmountCell(result, misAmount) {
  if (!result || result.excluded || result.status === 'CONTRA_ENTRY') return '';
  if (!BANK_DATE_STATUSES.has(result.status)) return '';
  if (isPooledMatch(result)) return misAmount == null ? '' : misAmount;
  if (result.bank) {
    const amt = result.bank.depositAmt ?? result.bank.withdrawalAmt;
    return amt == null ? '' : amt;
  }
  return '';
}

/**
 * DIFFERENCE = realization − MIS. 0 (not blank) when there is nothing to
 * compare, so the column still sums and the accounting format renders "-".
 * A blank realization must short-circuit BEFORE Number(): Number('') is 0,
 * which would otherwise make every unmatched row read as −(its MIS amount).
 */
function differenceCell(realizationAmt, misAmt) {
  if (realizationAmt === '' || realizationAmt === null || realizationAmt === undefined) return 0;
  const r = Number(realizationAmt);
  const m = Number(misAmt);
  if (!Number.isFinite(r) || !Number.isFinite(m)) return 0;
  return Math.round((r - m) * 100) / 100;
}

/**
 * REMARKS — the refund IRF reference for a contra, or the split-payment note
 * for a unit group, phrased as the sample does ("Amount credited through one
 * transaction but bill raised 3" / the reverse for a BANK_TO_MIS unit).
 */
function remarksCell(result) {
  if (!result || result.excluded) return '';
  if (result.status === 'CONTRA_ENTRY' && result.contra) {
    const no = result.contra.refundNo || '';
    const d = result.contra.chequeDate ? fmtDate(result.contra.chequeDate) : '';
    if (!no) return '';
    return d ? `${no}/${d}` : no;
  }
  if (/inward remittance/i.test(result.appliedRuleName || '') && result.bank) {
    const ref = result.bank.chqRefNo || (String(result.bank.narration || '').match(/\bINW\s+(\S+)/i) || [])[1] || '';
    const d = result.bank.txnDate ? fmtDate(result.bank.txnDate) : '';
    return `Drawn from inward remittance${ref ? ` ${ref}` : ''}${d ? ` dated ${d}` : ''}`;
  }
  if (result.unitCount && result.unitCount > 1) {
    const n = result.unitCount;
    return result.unitDirection === 'BANK_TO_MIS'
      ? `Amount credited through ${n} transactions but bill raised one`
      : `Amount credited through one transaction but bill raised ${n}`;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Per-sheet column specs. `header` and order are verbatim from the sample (the
// `\n` inside the DIFFERENCE headers included). `get(row)` reads the merged
// `{ ...record, __result, __seq }` and returns a RAW value (number, a
// 'YYYY-MM-DD' string for dates, a label, or ''). `total`: 'count' non-empty
// data cells, 'sum' numeric total, null blank. `fmt`: the Excel cell format the
// builder stamps on data + total cells — 'acct' | 'acctParen' | 'date' | null.
// ---------------------------------------------------------------------------

const DIFF_HEADER_ONLINE = 'DIFFERENCE \nD(CHEQUE CLEARANCE AMOUNT - CHEQUE AMOUNT';
const DIFF_HEADER_CHEQUE = '  DIFFERENCE \n(CHEQUE CLEARANCE AMOUNT - CHEQUE AMOUNT)  ';

const misOnline = (r) => r.onlineUpiAmount ?? r.billAmount ?? null;
const misCheque = (r) => r.chequeAmount ?? r.billAmount ?? null;

const bankName = (res) => (res && res.bank ? res.bank.bankName || '' : '');
const bankAcct = (res) => (res && res.bank ? bankAccountShort(res.bank.accountNo) : '');

/** Location the row was collected at — the batch's resolved division, else its raw unit name, upper-cased as the sample has it. */
const locationCell = (r) => String(r.division || r.unitName || '').toUpperCase();
const auditorCell = (r) => AUDITOR_BY_LOCATION[locationCell(r)] || '';

const ONLINE_COLUMNS = [
  { header: 'S NO', get: (r) => r.__seq, total: null },
  { header: 'MONTH', get: (r) => monthCell(r.receiptDate), total: 'count' },
  { header: 'LOCATION', get: locationCell, total: 'count' },
  { header: 'NAME OF THE AUDITOR', get: auditorCell, total: null },
  { header: 'IP/OP/DIAG', get: () => 'IP', total: 'count' },
  { header: 'RECEIPT NUMBER', get: (r) => r.receiptNumber ?? '', total: 'count' },
  { header: 'RECEIPT DATE', get: (r) => r.receiptDate ? String(r.receiptDate).slice(0, 10) : '', total: 'count', fmt: 'date' },
  { header: 'IPNO', get: (r) => r.ipNo ?? '', total: 'count' },
  { header: 'PATIENT NAME', get: (r) => r.patientName ?? '', total: 'count' },
  { header: 'ONLINE TRANSACTION ID', get: (r) => txnIdCell(r), total: 'count' },
  { header: 'EFT NO', get: (r) => (r.__result && r.__result.bank ? r.__result.bank.narration || '' : ''), total: 'count' },
  { header: 'ONLINE PAYMENT MODE', get: (r) => r.paymentMode ?? r.payMode ?? '', total: 'count' },
  { header: 'PAT TYPE', get: (r) => r.patType ?? '', total: 'count' },
  { header: 'ONLINE AMOUNT', get: (r) => misOnline(r) ?? '', total: 'sum', fmt: 'acct' },
  { header: 'DATE OF REALIZATION', get: (r) => realizationCell(r.__result), total: 'count', fmt: 'date' },
  { header: 'REALIZATION AMOUNT', get: (r) => realizationAmountCell(r.__result, misOnline(r)), total: 'sum', fmt: 'acct' },
  { header: 'NAME OF BANK', get: (r) => bankName(r.__result), total: 'count' },
  { header: 'BANK ACCOUNT NO.', get: (r) => bankAcct(r.__result), total: 'count' },
  { header: DIFF_HEADER_ONLINE, get: (r) => differenceCell(realizationAmountCell(r.__result, misOnline(r)), misOnline(r)), total: 'sum', fmt: 'acctParen' },
  { header: 'REMARKS', get: (r) => remarksCell(r.__result), total: 'count' },
  { header: 'USER ID', get: (r) => r.userId ?? '', total: 'count' },
  { header: 'CENTRAL AUDIT OBSERVATION', get: () => '', total: null },
];

const DIAG_COLUMNS = [
  { header: 'S NO', get: (r) => r.__seq, total: null },
  { header: 'MONTH', get: (r) => monthCell(r.receiptDate), total: 'count' },
  { header: 'LOCATION', get: locationCell, total: 'count' },
  { header: 'NAME OF THE AUDITOR', get: auditorCell, total: null },
  { header: 'IP/OP/DIAG', get: () => 'DIAG', total: 'count' },
  { header: 'RECEIPT NUMBER', get: (r) => r.receiptNumber ?? '', total: 'count' },
  { header: 'RECEIPT DATE', get: (r) => r.receiptDate ? String(r.receiptDate).slice(0, 10) : '', total: 'count', fmt: 'date' },
  { header: 'YHNO', get: (r) => r.yhno ?? '', total: 'count' },
  { header: 'DIAG NUMBER', get: (r) => r.diagNo ?? '', total: 'count' },
  { header: 'PATIENT NAME', get: (r) => r.patientName ?? '', total: 'count' },
  { header: 'ONLINE TRANSACTION ID', get: (r) => txnIdCell(r), total: 'count' },
  { header: 'EFT NO', get: (r) => (r.__result && r.__result.bank ? r.__result.bank.narration || '' : ''), total: 'count' },
  { header: 'ONLINE PAYMENT MODE', get: (r) => r.payMode ?? r.paymentMode ?? '', total: 'count' },
  { header: ' ONLINE AMOUNT ', get: (r) => misOnline(r) ?? '', total: 'sum', fmt: 'acct' },
  { header: 'DATE OF REALIZATION', get: (r) => realizationCell(r.__result), total: 'count', fmt: 'date' },
  { header: ' REALIZATION AMOUNT ', get: (r) => realizationAmountCell(r.__result, misOnline(r)), total: 'sum', fmt: 'acct' },
  { header: 'NAME OF BANK', get: (r) => bankName(r.__result), total: 'count' },
  { header: 'BANK ACCOUNT NO.', get: (r) => bankAcct(r.__result), total: 'count' },
  { header: DIFF_HEADER_ONLINE, get: (r) => differenceCell(realizationAmountCell(r.__result, misOnline(r)), misOnline(r)), total: 'sum', fmt: 'acctParen' },
  { header: 'REMARKS', get: (r) => remarksCell(r.__result), total: 'count' },
  { header: 'USER ID', get: (r) => r.userId ?? '', total: 'count' },
  { header: 'CENTRAL AUDIT OBSERVATION', get: () => '', total: null },
];

const CHEQUE_COLUMNS = [
  { header: 'S No', get: (r) => r.__seq, total: null },
  { header: 'MONTH', get: (r) => monthCell(r.receiptDate), total: 'count' },
  { header: 'LOCATION', get: locationCell, total: 'count' },
  { header: 'IP/DIAG', get: (r) => (String(r.collectionKind || 'IP').toUpperCase() === 'OP' ? 'DIAG' : 'IP'), total: 'count' },
  { header: 'RECEIPT NUMBER', get: (r) => r.receiptNumber ?? '', total: 'count' },
  { header: 'RECEIPT DATE', get: (r) => r.receiptDate ? String(r.receiptDate).slice(0, 10) : '', total: 'count', fmt: 'date' },
  { header: 'IP /DIAGNOSTICS NO', get: (r) => r.ipNo ?? r.diagNo ?? '', total: 'count' },
  { header: 'NAME OF THE PATIENT', get: (r) => r.patientName ?? '', total: 'count' },
  { header: 'CHEQUE NO.', get: (r) => r.chequeNo ?? '', total: 'count' },
  { header: 'EFT NO.', get: (r) => (r.__result && r.__result.bank ? r.__result.bank.chqRefNo || '' : ''), total: 'count' },
  { header: 'PATIENT TYPE', get: (r) => r.payType ?? r.patType ?? '', total: 'count' },
  { header: 'CHEQUE AMOUNT', get: (r) => misCheque(r) ?? '', total: 'sum', fmt: 'acct' },
  { header: 'DATE OF REALIZATION', get: (r) => realizationCell(r.__result), total: 'count', fmt: 'date' },
  { header: 'CHEQUE REALIZATION AMOUNT', get: (r) => realizationAmountCell(r.__result, misCheque(r)), total: 'sum', fmt: 'acct' },
  { header: 'NAME OF BANK', get: (r) => bankName(r.__result), total: 'count' },
  { header: 'BANK ACCOUNT NO.', get: (r) => bankAcct(r.__result), total: 'count' },
  { header: DIFF_HEADER_CHEQUE, get: (r) => differenceCell(realizationAmountCell(r.__result, misCheque(r)), misCheque(r)), total: 'sum', fmt: 'acctParen' },
  { header: 'REMARKS', get: (r) => remarksCell(r.__result), total: 'count' },
  { header: 'USER ID', get: (r) => r.userId ?? '', total: 'count' },
  { header: 'CENTRAL AUDIT OBSERVATION', get: () => '', total: null },
];

// Appended to every sheet in the INTERNAL variant only — never in the client
// output. Carries what the engine decided and why, so the FRS team can defend
// each row: verdict, the rule that fired, and the plain-language reason /
// unmatched diagnostic (`result.matchReason`).
const STATUS_LABEL = {
  MATCHED: 'Matched',
  EASEBUZZ_MATCHED: 'EaseBuzz Matched',
  CONTRA_ENTRY: 'Contra Entry',
  PARTIAL_MATCH: 'Partial Match',
  AMOUNT_MISMATCH: 'Amount Mismatch',
  AMBIGUOUS_MATCH: 'Ambiguous',
  UNMATCHED: 'Unmatched',
};
const INTERNAL_EXTRA_COLUMNS = [
  { header: 'MATCH STATUS', get: (r) => (r.__result && r.__result.excluded ? 'Excluded' : STATUS_LABEL[r.__result && r.__result.status] || (r.__result && r.__result.status) || ''), total: 'count' },
  { header: 'APPLIED RULE', get: (r) => (r.__result && r.__result.appliedRuleName) || '', total: 'count' },
  { header: 'REASON', get: (r) => (r.__result && r.__result.matchReason) || '', total: null },
  { header: 'BANK REF / NARRATION', get: (r) => (r.__result && r.__result.bank ? (r.__result.bank.chqRefNo || r.__result.bank.narration || '') : ''), total: null },
  { header: 'BANK AMOUNT', get: (r) => (r.__result && r.__result.bank ? (r.__result.bank.depositAmt ?? r.__result.bank.withdrawalAmt ?? '') : ''), total: 'sum', fmt: 'acct' },
];

/**
 * The preamble each sheet carries above its header row, verbatim from the
 * sample. `totals` is the computed per-column aggregate row (index 0 is the
 * "Total" label, 1..n the aggregates) — spread in at the position the sample
 * puts it (row 3 on every sheet, before the header).
 */
const SHEETS = [
  {
    key: 'CHEQUE',
    sheetName: 'CHEQUE COLL AND REALIZN',
    columns: CHEQUE_COLUMNS,
    misAmountOf: misCheque,
    preamble: (label, totals) => [
      ['SUMMARY', '', 'YASHODA HOSPITAL-ALL LOCATIONS'],
      [`CHEQUE COLLECTION AND REALIZATION STATEMENT FOR THE MONTH OF - ${label}`],
      ['OBJECTIVE IN COMMENT', '', 'SOURCE OF REPORT', 'MIS', 'PERCENTAGE', 20, 'MANUAL WORK', 'AUDIT', 'PERCENTAGE', 80],
      ['TOTAL', ...totals.slice(1)],
      ['', '', '', '', 'COLLECTION CHEQUES', '', '', 'CLEARED CHEQUES', '', '', 'PENDING CHEQUES'],
      [`CHEQUE COLLECTION REALISATIONS FOR THE MONTH OF ${label}`],
      ['AS PER MIS REPORT', '', '', '', '', '', '', '', '', '', '', '', 'REALIZATION DETAILS'],
    ],
  },
  {
    key: 'ONLINE',
    sheetName: 'ONLINE COLLECTION',
    columns: ONLINE_COLUMNS,
    misAmountOf: misOnline,
    preamble: (label, totals) => [
      ['SUMMARY', '', 'YASHODA HOSPITAL-ALL LOCATIONS'],
      [`ONLINE COLLECTION FOR THE MONTH OF - ${label}`],
      ['OBJECTIVE IN COMMENT', '', '', 'SOURCE OF REPORT', 'MIS', 'PERCENTAGE', 20, 'MANUAL WORK', 'AUDIT', 'PERCENTAGE', 80],
      ['Total', ...totals.slice(1)],
      ['AS PER MIS REPORT', '', '', '', '', '', '', '', '', '', '', '', '', '', '', 'BANK REALISATION DETAILS '],
    ],
  },
  {
    key: 'DIAG',
    sheetName: 'ONLINE DIAG COLLECTION',
    columns: DIAG_COLUMNS,
    misAmountOf: misOnline,
    preamble: (label, totals) => [
      ['SUMMARY', '', 'YASHODA HOSPITAL-ALL LOCATIONS'],
      [`ONLINE VIDEO COLLECTION REPORT FOR THE MONTH OF - ${label} (THREE UNITS SERVER DATA)`],
      ['OBJECTIVE IN COMMENT', '', '', 'SOURCE OF REPORT', 'MIS', 'PERCENTAGE', 20, 'MANUAL WORK', 'AUDIT', 'PERCENTAGE', 80],
      ['Total', ...totals.slice(1)],
    ],
  },
];

const SHEET_BY_KEY = new Map(SHEETS.map((s) => [s.key, s]));

/** Per-column aggregate row: index 0 the "Total" label placeholder, 1..n each column's count / sum / blank. */
function computeTotals(columns, rows) {
  return columns.map((col, idx) => {
    if (idx === 0) return 'Total';
    if (col.total === 'sum') {
      let s = 0;
      for (const r of rows) {
        const v = Number(col.get(r));
        if (Number.isFinite(v)) s += v;
      }
      return Math.round(s * 100) / 100;
    }
    if (col.total === 'count') {
      let c = 0;
      for (const r of rows) {
        const v = col.get(r);
        if (v !== '' && v !== null && v !== undefined) c += 1;
      }
      return c;
    }
    return '';
  });
}

/** Cheap per-sheet rollup for the screen's pre-download preview — no workbook built. */
function summariseSheet(key, rows) {
  const def = SHEET_BY_KEY.get(key);
  const out = { name: def ? def.sheetName : key, key, rowCount: rows.length, matched: 0, contra: 0, unmatched: 0, totalMisAmount: 0, totalRealizationAmount: 0, totalDifference: 0 };
  for (const r of rows) {
    const res = r.__result || {};
    const misRaw = def.misAmountOf(r);
    const realRaw = realizationAmountCell(res, misRaw);
    out.totalMisAmount += Number(misRaw) || 0;
    out.totalRealizationAmount += Number(realRaw) || 0;
    out.totalDifference += differenceCell(realRaw, misRaw);
    if (res.status === 'CONTRA_ENTRY') out.contra += 1;
    else if (res.status === 'MATCHED' || res.status === 'EASEBUZZ_MATCHED' || res.status === 'PARTIAL_MATCH') out.matched += 1;
    else out.unmatched += 1;
  }
  out.totalMisAmount = Math.round(out.totalMisAmount * 100) / 100;
  out.totalRealizationAmount = Math.round(out.totalRealizationAmount * 100) / 100;
  out.totalDifference = Math.round(out.totalDifference * 100) / 100;
  return out;
}

const COL_LETTER = (n) => XLSX.utils.encode_col(n);

/**
 * Stamps a column's Excel format onto every data + total cell in it: accounting
 * for amounts (so 0 shows as "-", thousands get commas), and real Excel dates
 * for date columns (a 'YYYY-MM-DD' string is converted to a serial + dd/mmm/yy;
 * a label like "CREDIT CONTRA ENTRY" is left as text).
 */
function applyColumnFormat(ws, colIndex, fmt, firstDataRow, lastRow) {
  const letter = COL_LETTER(colIndex);
  for (let row = firstDataRow; row <= lastRow; row++) {
    const addr = `${letter}${row + 1}`;
    const cell = ws[addr];
    if (!cell) continue;
    if (fmt === 'date') {
      const serial = typeof cell.v === 'string' ? excelSerial(cell.v) : null;
      if (serial !== null) {
        cell.t = 'n';
        cell.v = serial;
        cell.z = FMT_DATE;
      }
      continue;
    }
    // accounting formats — only meaningful on a number
    if (typeof cell.v === 'number') cell.z = fmt === 'acctParen' ? FMT_ACCT_PAREN : FMT_ACCT;
  }
}

/**
 * @param {{ periodLabel: string, sheets: { key: string, rows: object[] }[], variant?: 'client'|'internal' }} input
 *   sheets[].rows are `{ ...mappedRecord, __result, __seq }`. A key omitted ->
 *   that sheet is written empty (preamble + header), so the workbook always has
 *   the client's full sheet set (CHEQUE, ONLINE, DIAG).
 *   variant 'internal' appends the engine's verdict / rule / reason columns to
 *   every sheet; 'client' (default) is the exact client layout.
 */
function buildAuditWorkbook({ periodLabel, sheets, variant = 'client' }) {
  const bySheet = new Map((sheets || []).map((s) => [s.key, s.rows || []]));
  const internal = variant === 'internal';
  const wb = XLSX.utils.book_new();
  for (const def of SHEETS) {
    const rows = bySheet.get(def.key) || [];
    const columns = internal ? [...def.columns, ...INTERNAL_EXTRA_COLUMNS] : def.columns;
    const totals = computeTotals(columns, rows);
    const preamble = def.preamble(periodLabel, totals);
    const totalRowIndex = preamble.findIndex((r) => /^total$/i.test(String(r[0] || '')));
    const headerRowIndex = preamble.length; // header sits right after the preamble

    const aoa = [...preamble];
    aoa.push(columns.map((c) => c.header));
    for (const r of rows) aoa.push(columns.map((c) => (c.get(r) ?? '')));

    const ws = XLSX.utils.aoa_to_sheet(aoa);

    // Stamp per-column number / date formats onto the data block and, for the
    // amount columns, the Total row too (dates skip the Total row).
    columns.forEach((col, i) => {
      if (!col.fmt) return;
      applyColumnFormat(ws, i, col.fmt, headerRowIndex + 1, aoa.length - 1);
      if (col.fmt !== 'date' && totalRowIndex >= 0) applyColumnFormat(ws, i, col.fmt, totalRowIndex, totalRowIndex);
    });

    XLSX.utils.book_append_sheet(wb, ws, def.sheetName);
  }
  return wb;
}

module.exports = {
  SHEETS,
  AUDITOR_BY_LOCATION,
  excelSerial,
  fmtDate,
  monthCell,
  bankAccountShort,
  txnIdCell,
  realizationCell,
  realizationAmountCell,
  differenceCell,
  remarksCell,
  computeTotals,
  summariseSheet,
  buildAuditWorkbook,
};
