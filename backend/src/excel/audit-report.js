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
 *   CARD AND UPI COLLECTION — the weekly instrument-level bundle. NOT in the
 *                             client's sample: added when they asked for the
 *                             card/UPI module in the same deliverable. It is a
 *                             separate sheet because it is a separate row set
 *                             that does not join the MIS sheets above (matched
 *                             on receipt number, the overlap is 0 rows), and
 *                             because it carries a PERSISTED verdict rather
 *                             than a live `__result` — see UCR_COLUMNS.
 *
 * The sample also carries a WEB CONSULTATIONS sheet (tele / web consultation +
 * health-checkup payments). The client asked for it to be dropped — it duplicates
 * data already covered elsewhere — so it is no longer emitted.
 *
 * Beyond the sample, the client asked (Sep-26) for the sheets to carry every MIS
 * field, full bank realization detail, the reconciliation status and balance
 * amount, and the refund columns — things they had been hand-writing into
 * REMARKS. Those are folded into the column sets below rather than bolted on as
 * a second report.
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
 * Cheque numbers the client's own team deliberately enters as reference codes
 * to flag this type of transaction — not real instrument numbers, but not a
 * mistake either. Verified against live data: '12345' appears on 1,500+
 * refund_records rows and '123456' on 195 cheque_collection_records rows,
 * each under a different patient — a real cheque number is unique to one
 * instrument, so this many sharing one literal value is the team's own
 * marker, entered on purpose. A contra match keyed on one of these is not a
 * verified "this specific cheque came back" match, so it keeps the generic
 * label rather than the specific one.
 */
const REFERENCE_CODE_CHEQUE_NUMBERS = new Set(['12345', '123456']);

/**
 * Cheque numbers confirmed by the client as genuine data-entry mistakes (a
 * human mis-typed a real cheque number as this one) — '1234567' verified
 * against live data (3 refund_records rows, each a different patient). The
 * "match" this produces is therefore not a real contra entry at all; it must
 * not be labelled as either a verified match or even the generic placeholder
 * label — it should read exactly as an ordinary unmatched row would.
 */
const MISENTERED_CHEQUE_NUMBERS = new Set(['1234567']);

/**
 * DATE OF REALIZATION — either a real bank date ('YYYY-MM-DD', the workbook
 * builder turns it into a formatted Excel date) or one of the sample's literal
 * labels. A CONTRA_ENTRY reads "Yashoda refund Cheque" — every contra entry is,
 * by construction, a cheque collected and later refunded, reconciled against
 * the refund document instead of the bank — with two exceptions the client
 * asked for by cheque number: a known reference-code cheque number
 * (REFERENCE_CODE_CHEQUE_NUMBERS) stays the generic "CREDIT CONTRA ENTRY",
 * and a known mis-entered cheque number (MISENTERED_CHEQUE_NUMBERS) reads
 * blank, exactly as an unmatched row would — the match itself is a mistake,
 * not a real transaction. A rule-set `contra.realizationLabel` still wins
 * over all of this.
 */
function realizationCell(result, chequeNo) {
  if (!result || result.excluded) return '';
  if (result.status === 'CONTRA_ENTRY') {
    if (result.contra && result.contra.realizationLabel) return result.contra.realizationLabel;
    const cheque = chequeNo != null ? String(chequeNo).trim() : null;
    if (cheque && MISENTERED_CHEQUE_NUMBERS.has(cheque)) return '';
    if (cheque && REFERENCE_CODE_CHEQUE_NUMBERS.has(cheque)) return 'CREDIT CONTRA ENTRY';
    return 'Yashoda refund Cheque';
  }
  if (BANK_DATE_STATUSES.has(result.status)) {
    // An EaseBuzz receipt's counterpart is the gateway TRANSACTION row, whose
    // date is when the customer paid — not when the money reached the hospital.
    // EaseBuzz pays out in a lump on a later day; when the route has resolved
    // which, that is the real realization date. The client raised exactly this
    // ("Bank Date column showing as Receipt Date only instead of Realisation").
    if (result.settlementDate && result.settlementDate.date) {
      // Not settled yet: show when it is due, flagged, so it is never mistaken
      // for a confirmed date. Text by design — this column already carries
      // labels as well as dates, and the label must not format as a date.
      if (result.settlementDate.expected) return `EXPECTED ${fmtDate(result.settlementDate.date)}`;
      return String(result.settlementDate.date).slice(0, 10);
    }
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
 * REMARKS — no longer the compacted refund reference for a contra ("IRF.../
 * date"); the client asked for that broken out into its own REFUND NUMBER /
 * REFUND DATE / REFUND IP NUMBER / PATIENT NAME / REFUND AMOUNT columns
 * instead (see contraRefundField below) rather than packed into one text
 * cell, so a contra entry now reads blank here. Still carries the
 * split-payment note for a unit group, phrased as the sample does ("Amount
 * credited through one transaction but bill raised 3" / the reverse for a
 * BANK_TO_MIS unit).
 */
function remarksCell(result) {
  if (!result || result.excluded) return '';
  if (result.status === 'CONTRA_ENTRY') return '';
  if (/inward remittance/i.test(result.appliedRuleName || '') && result.bank) {
    const ref = result.bank.chqRefNo || (String(result.bank.narration || '').match(/\bINW\s+(\S+)/i) || [])[1] || '';
    const d = result.bank.txnDate ? fmtDate(result.bank.txnDate) : '';
    return `Drawn from inward remittance${ref ? ` ${ref}` : ''}${d ? ` dated ${d}` : ''}`;
  }
  if (result.unitCount && result.unitCount > 1) {
    return unitRemarks(result);
  }
  // EaseBuzz: the realization is a payout covering many receipts, so the same
  // three figures apply — what landed, how much of it HIS receipted, and the
  // balance. Without this the Balance Amount column would carry a number far
  // larger than the row's own receipt with nothing explaining it.
  if (result.settlementDate && !result.settlementDate.expected && result.settlementDate.payoutAmount != null) {
    const s = result.settlementDate;
    return balanceTemplate({
      realized: s.payoutAmount,
      receiptLines: [`Total No. of Receipts Raised - ${s.receiptedCount ?? 0}`],
      balance: s.balance,
    });
  }
  return '';
}

/**
 * The client's REMARKS template (2026-09-15), rendered in one place so the split
 * payment case and the EaseBuzz case cannot drift apart:
 *
 *   Total Realized Amount - Rs. 3,00,000/-
 *   Total No. of Receipts Raised - 2
 *   Balance Amount - Nil
 *
 * `receiptLines` is a list because the BANK_TO_MIS direction needs two lines
 * where every other case needs one.
 */
function balanceTemplate({ realized, receiptLines, balance }) {
  return [
    `Total Realized Amount - Rs. ${inrText(realized) || '—'}/-`,
    ...receiptLines,
    `Balance Amount - ${balance ? `Rs. ${inrText(balance)}/-` : 'Nil'}`,
  ].join('\n');
}

/** Indian digit grouping, e.g. 300000 -> "3,00,000". Blank for a non-number. */
function inrText(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

/**
 * The split-payment note, in the template the client asked for (2026-09-15):
 *
 *   Total Realized Amount - Rs. 3,00,000/-
 *   Total No. of Receipts Raised - 2
 *   Balance Amount - Nil
 *
 * It replaces the single sentence this used to carry ("Amount credited through
 * one transaction but bill raised 2") — the same information, but with the two
 * figures the auditor was otherwise reading off other columns and the balance
 * stated explicitly rather than left to be inferred.
 *
 * The three figures:
 *   realized  the bank credit the group was matched against — what actually
 *             came in. Taken from the bank row, falling back to
 *             `unitTotal - unitDifference` (the counterparty amount by
 *             definition) when the row is absent.
 *   receipts  how many MIS receipts share that one credit.
 *   balance   the shortfall, `max(0, -unitDifference)` — the client's own
 *             wording, "Nil" rather than 0 when the group ties exactly.
 *
 * Newlines are intentional; the sample's own headers use them the same way.
 * Excel shows all three lines only with Wrap Text on, which the installed
 * SheetJS CE cannot set (it writes no styling) — the text is there regardless.
 */
function unitRemarks(result) {
  const n = result.unitCount;
  const diff = Number(result.unitDifference);
  const balance = Number.isFinite(diff) ? Math.max(0, -diff) : null;

  let realized = result.bank ? result.bank.depositAmt ?? result.bank.withdrawalAmt : null;
  if (realized == null && Number.isFinite(Number(result.unitTotal)) && Number.isFinite(diff)) {
    realized = Number(result.unitTotal) - diff;
  }

  const receiptLines = result.unitDirection === 'BANK_TO_MIS'
    // The mirror case: many credits against one receipt. Calling those
    // "receipts raised" would be wrong, so the count is labelled for what it is.
    ? [`Total No. of Transactions Credited - ${n}`, 'Total No. of Receipts Raised - 1']
    : [`Total No. of Receipts Raised - ${n}`];

  return balanceTemplate({ realized, receiptLines, balance });
}

/**
 * REFUND NUMBER / REFUND DATE / REFUND IP NUMBER / PATIENT NAME / REFUND
 * AMOUNT — the refund-document detail behind a CONTRA_ENTRY, broken into its
 * own columns per the client's request (previously packed into one REMARKS
 * cell as "IRF.../date"). `result.contra` already carries every field here —
 * see applyContraPatches in matched-rules.routes.js — this is purely a
 * display-layer read, no engine change needed.
 *
 * Blank for a known mis-entered cheque number (MISENTERED_CHEQUE_NUMBERS),
 * same as realizationCell/remarksCell: that "match" is a data-entry mistake,
 * not real evidence, so nothing about it should be shown as if it were.
 * `field` is one of 'refundNo' | 'chequeDate' | 'ipNo' | 'patientName' | 'amount'.
 * `ipNo` falls back to the refund's diagNo — cheque collection covers both
 * inpatient and diagnostics, and a refund row only ever has one or the other.
 */
function contraRefundField(result, chequeNo, field) {
  if (!result || result.excluded || result.status !== 'CONTRA_ENTRY' || !result.contra) return '';
  const cheque = chequeNo != null ? String(chequeNo).trim() : null;
  if (cheque && MISENTERED_CHEQUE_NUMBERS.has(cheque)) return '';
  const contra = result.contra;
  if (field === 'ipNo') return contra.ipNo ?? contra.diagNo ?? '';
  if (field === 'chequeDate') return contra.chequeDate ? String(contra.chequeDate).slice(0, 10) : '';
  const value = contra[field];
  return value ?? '';
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

const STATUS_LABEL = {
  MATCHED: 'Matched',
  EASEBUZZ_MATCHED: 'EaseBuzz Matched',
  CONTRA_ENTRY: 'Contra Entry',
  PARTIAL_MATCH: 'Partial Match',
  AMOUNT_MISMATCH: 'Amount Mismatch',
  AMBIGUOUS_MATCH: 'Ambiguous',
  UNMATCHED: 'Unmatched',
};

const statusCell = (r) => {
  if (!r.__result) return '';
  if (r.__result.excluded) return 'Excluded';
  return STATUS_LABEL[r.__result.status] || r.__result.status || '';
};

/**
 * The shortfall on a unit-aggregated group: one bank credit covering several
 * receipts leaves `unitDifference` negative by the amount still outstanding.
 * The client writes this by hand today ("...BALANCE AMOUNT RS."); this is the
 * column that replaces that.
 *
 * Blank on the CHEQUE sheet by construction — `cheque_matching_rules` carries no
 * UNIT_AGGREGATION rule, so cheque rows never receive a `unitDifference`.
 */
const balanceCell = (r) => {
  const result = r.__result;
  if (!result) return '';
  // Split payment: one credit, several receipts that fall short of it.
  const d = result.unitDifference;
  if (d != null && d < 0) return Math.round(-d * 100) / 100;
  // EaseBuzz: the payout reached the bank but HIS never raised receipts for all
  // of it. The client's point 3 — "when Total Realization Amounts are not raised
  // in HIS, asked for Balance Amount ... but showing as Blank".
  //
  // The two cases cannot both apply: EASEBUZZ_MATCHED is terminal
  // (reconciliation/rules.js), so the unit pass never claims an EaseBuzz row.
  if (result.settlementDate && result.settlementDate.balance) return result.settlementDate.balance;
  return '';
};

// --- blocks shared by all three sheets -------------------------------------
// Written once and spread into each column array. The bank block sits inside the
// "BANK REALISATION DETAILS" band; the recon block carries the verdict the client
// asked to see on their own sheets (it was previously internal-only).

/** Bank-side detail the client asked for beyond the four columns already present. */
const bankDetailColumns = (refHeader, refGet) => [
  { header: 'BANK ACCOUNT NUMBER (FULL)', get: (r) => (r.__result && r.__result.bank ? r.__result.bank.accountNo || '' : ''), total: 'count' },
  { header: refHeader, get: refGet, total: 'count' },
  // Same value as LOCATION, repeated inside the bank band because the client
  // reads realization details as a self-contained block.
  { header: 'BANK REALIZATION LOCATION', get: locationCell, total: 'count' },
];

const reconColumns = () => [
  { header: 'RECONCILIATION STATUS', get: statusCell, total: 'count' },
  // `total: null` deliberately: a group's shortfall is stamped on every member
  // row, so a per-row sum reports it two or three times over. The summary
  // endpoint dedupes by unitKey for exactly this reason.
  { header: 'BALANCE AMOUNT', get: balanceCell, total: null, fmt: 'acct' },
];

/**
 * The five refund columns. `chequeNoOf` is how the sheet identifies the row to
 * `contraRefundField`'s mis-entered-cheque guard — the cheque sheet passes its
 * cheque number, the online sheets have none and pass null.
 */
const refundColumns = (chequeNoOf, patientHeader) => [
  { header: 'REFUND NUMBER', get: (r) => contraRefundField(r.__result, chequeNoOf(r), 'refundNo'), total: 'count' },
  { header: 'REFUND DATE', get: (r) => contraRefundField(r.__result, chequeNoOf(r), 'chequeDate'), total: 'count', fmt: 'date' },
  { header: 'REFUND IP NUMBER', get: (r) => contraRefundField(r.__result, chequeNoOf(r), 'ipNo'), total: 'count' },
  { header: patientHeader, get: (r) => contraRefundField(r.__result, chequeNoOf(r), 'patientName'), total: 'count' },
  { header: 'REFUND AMOUNT', get: (r) => contraRefundField(r.__result, chequeNoOf(r), 'amount'), total: 'sum', fmt: 'acct' },
];

const ONLINE_COLUMNS = [
  { header: 'S NO', get: (r) => r.__seq, total: null },
  { header: 'MONTH', get: (r) => monthCell(r.receiptDate), total: 'count' },
  { header: 'LOCATION', get: locationCell, total: 'count' },
  { header: 'NAME OF THE AUDITOR', get: auditorCell, total: null },
  { header: 'IP/OP/DIAG', get: () => 'IP', total: 'count' },
  { header: 'RECEIPT NUMBER', get: (r) => r.receiptNumber ?? '', total: 'count' },
  { header: 'RECEIPT DATE', get: (r) => r.receiptDate ? String(r.receiptDate).slice(0, 10) : '', total: 'count', fmt: 'date' },
  { header: 'IPNO', get: (r) => r.ipNo ?? '', total: 'count' },
  { header: 'YHNO', get: (r) => r.yhno ?? '', total: 'count' },
  { header: 'PATIENT NAME', get: (r) => r.patientName ?? '', total: 'count' },
  { header: 'ONLINE TRANSACTION ID', get: (r) => txnIdCell(r), total: 'count' },
  { header: 'EFT NO', get: (r) => (r.__result && r.__result.bank ? r.__result.bank.narration || '' : ''), total: 'count' },
  { header: 'ONLINE PAYMENT MODE', get: (r) => r.paymentMode ?? r.payMode ?? '', total: 'count' },
  { header: 'PAT TYPE', get: (r) => r.patType ?? '', total: 'count' },
  { header: 'PAY TYPE', get: (r) => r.payType ?? '', total: 'count' },
  { header: 'ONLINE AMOUNT', get: (r) => misOnline(r) ?? '', total: 'sum', fmt: 'acct' },
  // The rest of the MIS amount split, which the curated sheet did not carry.
  { header: 'BILL AMOUNT', get: (r) => r.billAmount ?? '', total: 'sum', fmt: 'acct' },
  { header: 'CASH AMOUNT', get: (r) => r.cashAmount ?? '', total: 'sum', fmt: 'acct' },
  { header: 'CARD AMOUNT', get: (r) => r.cardAmount ?? '', total: 'sum', fmt: 'acct' },
  { header: 'CHEQUE AMOUNT', get: (r) => r.chequeAmount ?? '', total: 'sum', fmt: 'acct' },
  // Named MIS REMARKS, not REMARKS — the sheet already has a REMARKS column and
  // it holds the engine's remark, not the one typed into the HIS.
  { header: 'MIS REMARKS', get: (r) => r.remarks ?? '', total: 'count' },
  { header: 'PAYMENT REMARKS', get: (r) => r.paymentRemarks ?? '', total: 'count' },
  { header: 'DATE OF REALIZATION', get: (r) => realizationCell(r.__result), total: 'count', fmt: 'date' },
  { header: 'REALIZATION AMOUNT', get: (r) => realizationAmountCell(r.__result, misOnline(r)), total: 'sum', fmt: 'acct' },
  // The EaseBuzz payout this receipt travelled in — the WHOLE lump, shared with
  // every other receipt settled that day, which is why the header says manual
  // check. What the app can prove is which day's payout a receipt went out in;
  // which receipts make up the lump is not determinable from the files (only
  // 18% of multi-settlement days have a unique split), so a human confirms it.
  //
  // `total: null` deliberately: the payout repeats on every member row, so
  // summing the column would multiply each payout by its receipt count — the
  // same trap as BALANCE AMOUNT and the UCR group figures.
  {
    header: 'EASEBUZZ PAYOUT (MANUAL CHECK)',
    get: (r) => (r.__result && r.__result.settlementDate ? r.__result.settlementDate.payoutAmount ?? '' : ''),
    total: null,
    fmt: 'acct',
  },
  { header: 'NAME OF BANK', get: (r) => bankName(r.__result), total: 'count' },
  { header: 'BANK ACCOUNT NO.', get: (r) => bankAcct(r.__result), total: 'count' },
  // EFT NO above already carries the detailed narration on this sheet, so the
  // short form is what is missing.
  ...bankDetailColumns('BANK REFERENCE NO.', (r) => (r.__result && r.__result.bank ? r.__result.bank.chqRefNo || '' : '')),
  { header: DIFF_HEADER_ONLINE, get: (r) => differenceCell(realizationAmountCell(r.__result, misOnline(r)), misOnline(r)), total: 'sum', fmt: 'acctParen' },
  ...reconColumns(),
  { header: 'REMARKS', get: (r) => remarksCell(r.__result), total: 'count' },
  // Blank until a CONTRA_ENTRY rule exists for the IP stream — the rule table
  // carries only UNIT_AGGREGATION rules today.
  ...refundColumns(() => null, 'REFUND PATIENT NAME'),
  { header: 'USER ID', get: (r) => r.userId ?? '', total: 'count' },
  { header: 'USER NAME', get: (r) => r.userName ?? '', total: 'count' },
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
  { header: 'PAT TYPE', get: (r) => r.patType ?? '', total: 'count' },
  { header: ' ONLINE AMOUNT ', get: (r) => misOnline(r) ?? '', total: 'sum', fmt: 'acct' },
  { header: 'BILL AMOUNT', get: (r) => r.billAmount ?? '', total: 'sum', fmt: 'acct' },
  { header: 'CASH AMOUNT', get: (r) => r.cashAmount ?? '', total: 'sum', fmt: 'acct' },
  { header: 'CARD AMOUNT', get: (r) => r.cardAmount ?? '', total: 'sum', fmt: 'acct' },
  { header: 'CHEQUE AMOUNT', get: (r) => r.chequeAmount ?? '', total: 'sum', fmt: 'acct' },
  // Diag-only MIS fields.
  { header: 'DISCOUNT AMOUNT', get: (r) => r.discountAmount ?? '', total: 'sum', fmt: 'acct' },
  { header: 'DIFF AMOUNT', get: (r) => r.diffAmount ?? '', total: 'sum', fmt: 'acct' },
  { header: 'DATE OF REALIZATION', get: (r) => realizationCell(r.__result), total: 'count', fmt: 'date' },
  { header: ' REALIZATION AMOUNT ', get: (r) => realizationAmountCell(r.__result, misOnline(r)), total: 'sum', fmt: 'acct' },
  { header: 'NAME OF BANK', get: (r) => bankName(r.__result), total: 'count' },
  { header: 'BANK ACCOUNT NO.', get: (r) => bankAcct(r.__result), total: 'count' },
  ...bankDetailColumns('BANK REFERENCE NO.', (r) => (r.__result && r.__result.bank ? r.__result.bank.chqRefNo || '' : '')),
  { header: DIFF_HEADER_ONLINE, get: (r) => differenceCell(realizationAmountCell(r.__result, misOnline(r)), misOnline(r)), total: 'sum', fmt: 'acctParen' },
  ...reconColumns(),
  { header: 'REMARKS', get: (r) => remarksCell(r.__result), total: 'count' },
  ...refundColumns(() => null, 'REFUND PATIENT NAME'),
  { header: 'USER ID', get: (r) => r.userId ?? '', total: 'count' },
  { header: 'USER NAME', get: (r) => r.userName ?? '', total: 'count' },
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
  { header: 'CHEQUE DATE', get: (r) => (r.chequeDate ? String(r.chequeDate).slice(0, 10) : ''), total: 'count', fmt: 'date' },
  { header: 'EFT NO.', get: (r) => (r.__result && r.__result.bank ? r.__result.bank.chqRefNo || '' : ''), total: 'count' },
  { header: 'PATIENT TYPE', get: (r) => r.payType ?? r.patType ?? '', total: 'count' },
  // The cheque's OWN bank/branch, from the MIS row — not the realizing bank,
  // which is NAME OF BANK further right and comes off the bank statement.
  { header: 'DRAWEE BANK', get: (r) => r.bankName ?? '', total: 'count' },
  { header: 'DRAWEE BRANCH', get: (r) => r.branchName ?? '', total: 'count' },
  { header: 'CHEQUE AMOUNT', get: (r) => misCheque(r) ?? '', total: 'sum', fmt: 'acct' },
  { header: 'RECEIPT AMOUNT', get: (r) => r.receiptAmount ?? '', total: 'sum', fmt: 'acct' },
  { header: 'DATE OF REALIZATION', get: (r) => realizationCell(r.__result, r.chequeNo), total: 'count', fmt: 'date' },
  { header: 'CHEQUE REALIZATION AMOUNT', get: (r) => realizationAmountCell(r.__result, misCheque(r)), total: 'sum', fmt: 'acct' },
  { header: 'NAME OF BANK', get: (r) => bankName(r.__result), total: 'count' },
  { header: 'BANK ACCOUNT NO.', get: (r) => bankAcct(r.__result), total: 'count' },
  // EFT NO. above already carries the short reference on this sheet, so the
  // detailed narration is what is missing — the mirror of the online sheets.
  ...bankDetailColumns('BANK NARRATION', (r) => (r.__result && r.__result.bank ? r.__result.bank.narration || '' : '')),
  { header: DIFF_HEADER_CHEQUE, get: (r) => differenceCell(realizationAmountCell(r.__result, misCheque(r)), misCheque(r)), total: 'sum', fmt: 'acctParen' },
  ...reconColumns(),
  { header: 'REMARKS', get: (r) => remarksCell(r.__result), total: 'count' },
  // PATIENT NAME (not REFUND PATIENT NAME) — this sheet has no other column of
  // that name, and the header is locked to the client's sample.
  ...refundColumns((r) => r.chequeNo, 'PATIENT NAME'),
  { header: 'USER ID', get: (r) => r.userId ?? '', total: 'count' },
  { header: 'USER NAME', get: (r) => r.userName ?? '', total: 'count' },
  { header: 'CENTRAL AUDIT OBSERVATION', get: () => '', total: null },
];

// ---------------------------------------------------------------------------
// CARD & UPI sheet (the "UCR" stream).
//
// A separate sheet rather than extra columns on the sheets above, because it is
// a different row set entirely: it comes from the weekly instrument-level
// bundle, not the monthly MIS export, and the two do not join — matched on
// receipt number, ip_payment_records (12,218 rows) and ucr_ip_records (5,028)
// overlap in exactly 0 rows.
//
// It also reads a different verdict. The three sheets above re-run the CNF
// engine live per request; these rows carry the verdict the card/UPI matchers
// already persisted, so `matchStatus` is read straight off the record and there
// is no `__result` here at all.
// ---------------------------------------------------------------------------

const GATEWAY_LABEL = { CARD_MPR: 'Card MPR', CARD_PINELABS: 'Pine Labs', UPI_MPR: 'UPI MPR' };

/** The hydrated gateway row (see ucr-record-query.js), or null when unmatched. */
const gw = (r) => r.matchedSource || null;
const gwField = (field) => (r) => {
  const g = gw(r);
  return g && g[field] != null ? g[field] : '';
};

const UCR_COLUMNS = [
  { header: 'S NO', get: (r) => r.__seq, total: null },
  { header: 'MONTH', get: (r) => monthCell(r.receiptDate), total: 'count' },
  // Always blank: the weekly bundle carries no unit column, its batch table has
  // no unit_name, and the gateway side is a single merchant / store / MID. There
  // is no unit dimension to report. Kept so the sheet lines up with the others.
  { header: 'LOCATION', get: () => '', total: null },
  { header: 'IP/OP/DIAG', get: (r) => r.misSource ?? '', total: 'count' },
  { header: 'RECEIPT NUMBER', get: (r) => r.receiptNo ?? '', total: 'count' },
  { header: 'RECEIPT DATE', get: (r) => (r.receiptDate ? String(r.receiptDate).slice(0, 10) : ''), total: 'count', fmt: 'date' },
  { header: 'YHNO', get: (r) => r.yhNo ?? '', total: 'count' },
  { header: 'IP / DIAG NO', get: (r) => r.ipNo ?? r.diagNo ?? '', total: 'count' },
  { header: 'PATIENT NAME', get: (r) => r.patientName ?? '', total: 'count' },
  { header: 'BILL NO', get: (r) => r.billNo ?? '', total: 'count' },
  { header: 'INSTRUMENT TYPE', get: (r) => r.instrumentType ?? '', total: 'count' },
  { header: 'REFERENCE ID', get: (r) => r.referenceId ?? '', total: 'count' },
  { header: 'AMOUNT', get: (r) => r.amount ?? '', total: 'sum', fmt: 'acct' },
  // --- gateway realization details ---
  { header: 'SETTLEMENT DATE', get: gwField('date'), total: 'count', fmt: 'date' },
  { header: 'GATEWAY', get: (r) => GATEWAY_LABEL[r.matchSourceType] || '', total: 'count' },
  { header: 'GROSS AMOUNT', get: gwField('amount'), total: 'sum', fmt: 'acct' },
  // The processor deducts its fee before settling, so NET is what actually
  // reached the bank. Pine Labs settles gross and reports no fee column, so the
  // fee reads blank there rather than 0.
  { header: 'MSF / COMMISSION', get: gwField('feeAmount'), total: 'sum', fmt: 'acct' },
  { header: 'NET AMOUNT', get: gwField('netAmount'), total: 'sum', fmt: 'acct' },
  { header: 'RRN / ARN', get: gwField('rrn'), total: 'count' },
  { header: 'GATEWAY TRANSACTION ID', get: gwField('transactionId'), total: 'count' },
  // --- reconciliation ---
  { header: 'RECONCILIATION STATUS', get: (r) => STATUS_LABEL[r.matchStatus] || r.matchStatus || '', total: 'count' },
  // Both are GROUP figures: several receipts can share one reference, and the
  // verdict is decided on their sum. Repeated on every member row, so `total`
  // is null — summing them down the column would count each group once per
  // member. 1,120 of the 5,028 rows are in such a group.
  { header: 'GROUP AMOUNT', get: (r) => r.matchGroupAmount ?? '', total: null, fmt: 'acct' },
  { header: 'DIFFERENCE', get: (r) => r.matchDifference ?? '', total: null, fmt: 'acctParen' },
  { header: 'REASON', get: (r) => r.matchReason ?? '', total: null },
  { header: 'USER ID', get: (r) => r.userId ?? '', total: 'count' },
  { header: 'USER NAME', get: (r) => r.userName ?? '', total: 'count' },
  { header: 'CENTRAL AUDIT OBSERVATION', get: () => '', total: null },
];

// Appended to every sheet in the INTERNAL variant only — never in the client
// output. Carries what the engine decided and why, so the FRS team can defend
// each row: the rule that fired and the plain-language reason / unmatched
// diagnostic (`result.matchReason`).
//
// The verdict itself is NOT here any more: the client asked for it on their own
// sheets, so it now ships as RECONCILIATION STATUS in every column set. Leaving
// MATCH STATUS here as well would print the same value twice on the internal
// variant.
const INTERNAL_EXTRA_COLUMNS = [
  { header: 'APPLIED RULE', get: (r) => (r.__result && r.__result.appliedRuleName) || '', total: 'count' },
  { header: 'REASON', get: (r) => (r.__result && r.__result.matchReason) || '', total: null },
  { header: 'BANK REF / NARRATION', get: (r) => (r.__result && r.__result.bank ? (r.__result.bank.chqRefNo || r.__result.bank.narration || '') : ''), total: null },
  { header: 'BANK AMOUNT', get: (r) => (r.__result && r.__result.bank ? (r.__result.bank.depositAmt ?? r.__result.bank.withdrawalAmt ?? '') : ''), total: 'sum', fmt: 'acct' },
];

/**
 * A preamble band row whose labels are positioned by the header they sit above
 * rather than by a hand-counted index.
 *
 * The sample's two-tier band ("AS PER MIS REPORT" … "BANK REALISATION DETAILS")
 * is written as a plain padded array, so before this helper every band label was
 * pinned to a literal column number. Inserting a column anywhere to its left
 * shifted the data but not the label, silently mis-banding the sheet — and
 * nothing would have failed. Anchoring to `header` makes the band follow its
 * column wherever it ends up.
 *
 * @param {Array<{header: string}>} columns the sheet's column spec
 * @param {...[string, string]} pairs [headerToSitAbove, labelText]
 */
function positionedRow(columns, pairs) {
  const row = [];
  for (const [header, label] of pairs) {
    const i = columns.findIndex((c) => c.header === header);
    if (i < 0) throw new Error(`positionedRow: no column with header "${header}"`);
    row[i] = label;
  }
  for (let i = 0; i < row.length; i += 1) if (row[i] === undefined) row[i] = '';
  return row;
}

/**
 * A two-tier band row. Tagged so the builder merges each label across its block
 * — the tag is a property on the array, which `aoa_to_sheet` ignores because it
 * only walks numeric indices.
 */
function bandRow(columns, ...pairs) {
  const row = positionedRow(columns, pairs);
  Object.defineProperty(row, '__band', { value: true });
  return row;
}

/** Positioned labels that are NOT a band — no merging (they label a few columns, not a block). */
function labelRow(columns, ...pairs) {
  return positionedRow(columns, pairs);
}

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
    preamble: (period, totals) => [
      ['SUMMARY', '', 'YASHODA HOSPITAL-ALL LOCATIONS'],
      [`CHEQUE COLLECTION AND REALIZATION STATEMENT ${period.titlePhrase}`],
      ['OBJECTIVE IN COMMENT', '', 'SOURCE OF REPORT', 'MIS', 'PERCENTAGE', 20, 'MANUAL WORK', 'AUDIT', 'PERCENTAGE', 80],
      ['TOTAL', ...totals.slice(1)],
      labelRow(
        CHEQUE_COLUMNS,
        ['RECEIPT NUMBER', 'COLLECTION CHEQUES'],
        ['NAME OF THE PATIENT', 'CLEARED CHEQUES'],
        ['PATIENT TYPE', 'PENDING CHEQUES'],
      ),
      [`CHEQUE COLLECTION REALISATIONS ${period.titlePhraseBare}`],
      bandRow(
        CHEQUE_COLUMNS,
        ['S No', 'AS PER MIS REPORT'],
        ['DATE OF REALIZATION', 'REALIZATION DETAILS'],
      ),
    ],
  },
  {
    key: 'ONLINE',
    sheetName: 'ONLINE COLLECTION',
    columns: ONLINE_COLUMNS,
    misAmountOf: misOnline,
    preamble: (period, totals) => [
      ['SUMMARY', '', 'YASHODA HOSPITAL-ALL LOCATIONS'],
      [`ONLINE COLLECTION ${period.titlePhrase}`],
      ['OBJECTIVE IN COMMENT', '', '', 'SOURCE OF REPORT', 'MIS', 'PERCENTAGE', 20, 'MANUAL WORK', 'AUDIT', 'PERCENTAGE', 80],
      ['Total', ...totals.slice(1)],
      // Anchored to DATE OF REALIZATION, where the client's own sample starts
      // the band. The old hand-counted index put it one column later, leaving
      // the realization date sitting under "AS PER MIS REPORT" — visible now
      // that the band is merged and the block has grown.
      // Trailing space on the label is verbatim from the client's sample.
      bandRow(
        ONLINE_COLUMNS,
        ['S NO', 'AS PER MIS REPORT'],
        ['DATE OF REALIZATION', 'BANK REALISATION DETAILS '],
      ),
    ],
  },
  {
    key: 'DIAG',
    sheetName: 'ONLINE DIAG COLLECTION',
    columns: DIAG_COLUMNS,
    misAmountOf: misOnline,
    preamble: (period, totals) => [
      ['SUMMARY', '', 'YASHODA HOSPITAL-ALL LOCATIONS'],
      [`ONLINE VIDEO COLLECTION REPORT ${period.titlePhrase} (THREE UNITS SERVER DATA)`],
      ['OBJECTIVE IN COMMENT', '', '', 'SOURCE OF REPORT', 'MIS', 'PERCENTAGE', 20, 'MANUAL WORK', 'AUDIT', 'PERCENTAGE', 80],
      ['Total', ...totals.slice(1)],
    ],
  },
  {
    key: 'UCR',
    sheetName: 'CARD AND UPI COLLECTION',
    columns: UCR_COLUMNS,
    misAmountOf: (r) => r.amount ?? null,
    /**
     * These rows carry a persisted verdict instead of a live `__result`, so the
     * default summariser (which reads `r.__result`) cannot read them.
     *
     * Whole-sheet rather than per-row because the gateway figures are GROUP
     * figures: when several receipts share one reference, every member row
     * carries the same gateway amount and the same difference, so summing down
     * the column counts that group once per member. Realization and difference
     * are therefore accumulated once per distinct gateway row.
     */
    summarise: (rows, out) => {
      const seen = new Set();
      for (const r of rows) {
        out.totalMisAmount += Number(r.amount) || 0;
        if (r.matchStatus === 'MATCHED') out.matched += 1;
        else out.unmatched += 1;

        const g = r.matchedSource;
        if (!g) continue;
        const groupKey = `${r.matchSourceType}:${r.matchSourceId}`;
        if (seen.has(groupKey)) continue;
        seen.add(groupKey);
        out.totalRealizationAmount += Number(g.amount) || 0;
        // Stored difference is groupAmount - gatewayAmount; the report's
        // DIFFERENCE convention is realization - MIS, hence the sign flip.
        out.totalDifference += r.matchDifference != null ? -Number(r.matchDifference) : 0;
      }
    },
    preamble: (period, totals) => [
      ['SUMMARY', '', 'YASHODA HOSPITAL-ALL LOCATIONS'],
      [`CARD AND UPI COLLECTION ${period.titlePhrase}`],
      ['OBJECTIVE IN COMMENT', '', '', 'SOURCE OF REPORT', 'MIS', 'PERCENTAGE', 20, 'MANUAL WORK', 'AUDIT', 'PERCENTAGE', 80],
      ['Total', ...totals.slice(1)],
      bandRow(
        UCR_COLUMNS,
        ['S NO', 'AS PER MIS REPORT'],
        ['SETTLEMENT DATE', 'GATEWAY REALISATION DETAILS'],
        ['RECONCILIATION STATUS', 'RECONCILIATION'],
      ),
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
  // A sheet whose rows carry a persisted verdict rather than a live `__result`
  // (the CARD AND UPI sheet) supplies its own summariser.
  if (def.summarise) {
    def.summarise(rows, out);
    out.totalMisAmount = Math.round(out.totalMisAmount * 100) / 100;
    out.totalRealizationAmount = Math.round(out.totalRealizationAmount * 100) / 100;
    out.totalDifference = Math.round(out.totalDifference * 100) / 100;
    return out;
  }
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
 * Merge ranges for every band row in a preamble: each label spans from its own
 * column up to the one before the next label (the last runs to the sheet edge).
 *
 * Without this the band is loose text sitting in one cell, which is how the
 * sample's two-tier header used to degrade — "BANK REALISATION DETAILS" looked
 * like a stray value in the realization-date column rather than a heading over
 * the block. `!merges` is structural, not styling, so SheetJS CE writes it.
 */
function bandMerges(preamble, columnCount) {
  const merges = [];
  preamble.forEach((row, r) => {
    if (!row.__band) return;
    const anchors = [];
    for (let c = 0; c < columnCount; c += 1) if (row[c] !== undefined && row[c] !== '') anchors.push(c);
    anchors.forEach((c, i) => {
      const end = i + 1 < anchors.length ? anchors[i + 1] - 1 : columnCount - 1;
      if (end > c) merges.push({ s: { r, c }, e: { r, c: end } });
    });
  });
  return merges;
}

// Columns holding free text need room; everything else is sized off its header.
const WIDE_COLUMN = /NARRATION|REMARKS|REASON|PATIENT|OBSERVATION|TRANSACTION ID|EFT NO|RRN|REFERENCE/;

/** Display width in characters. Excel defaults to ~8, which truncates almost every header here. */
function columnWidth(col) {
  const header = String(col.header).replace(/\n/g, ' ').trim();
  if (WIDE_COLUMN.test(header)) return 32;
  return Math.max(11, Math.min(24, header.length + 2));
}

/**
 * @param {{ periodLabel: string, sheets: { key: string, rows: object[] }[], variant?: 'client'|'internal' }} input
 *   sheets[].rows are `{ ...mappedRecord, __result, __seq }`. A key omitted ->
 *   that sheet is written empty (preamble + header), so the workbook always has
 *   the client's full sheet set (CHEQUE, ONLINE, DIAG).
 *   variant 'internal' appends the engine's verdict / rule / reason columns to
 *   every sheet; 'client' (default) is the exact client layout.
 */
function buildAuditWorkbook({ periodLabel, periodTitlePhrase, periodTitlePhraseBare, sheets, variant = 'client' }) {
  const bySheet = new Map((sheets || []).map((s) => [s.key, s.rows || []]));
  const internal = variant === 'internal';
  // The heading wording. A single month/day/year keeps the client's original
  // "FOR THE MONTH OF - JUL-26"; a multi-month range supplies its own phrase,
  // because "FOR THE MONTH OF" would misdescribe it. Defaulting here keeps
  // every existing caller — and the unit tests — working unchanged.
  const period = {
    label: periodLabel,
    titlePhrase: periodTitlePhrase ?? `FOR THE MONTH OF - ${periodLabel}`,
    titlePhraseBare: periodTitlePhraseBare ?? `FOR THE MONTH OF ${periodLabel}`,
  };
  const wb = XLSX.utils.book_new();
  for (const def of SHEETS) {
    const rows = bySheet.get(def.key) || [];
    const columns = internal ? [...def.columns, ...INTERNAL_EXTRA_COLUMNS] : def.columns;
    const totals = computeTotals(columns, rows);
    const preamble = def.preamble(period, totals);
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

    const merges = bandMerges(preamble, columns.length);
    if (merges.length) ws['!merges'] = merges;
    ws['!cols'] = columns.map((col) => ({ wch: columnWidth(col) }));

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
  contraRefundField,
  computeTotals,
  summariseSheet,
  buildAuditWorkbook,
};
