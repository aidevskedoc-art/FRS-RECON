/**
 * Builds the OLDER pipelines' rows — Online Collection MIS (IP and
 * Diagnostics/OP), cheque collection ledger, refund document — from the
 * client's combined "All Collections" HIS workbook.
 *
 * Why this exists: the client now sends one workbook in place of those four
 * exports. Every row here reproduces what the dedicated export put in the same
 * table, so the existing matching rules, contra pass and reports see the same
 * values they always did. Each convention below was measured against the
 * stored SBD Aug-26 exports (scripts/test-his-mis-rows.js holds the evidence).
 *
 * What the workbook genuinely lacks is left null, never guessed:
 *   - payer / TPA (pat_type on IP rows, pay_type on cheques) — only the
 *     International rule reads it (patType contains "INT");
 *   - the bank-transfer sub-type (NEFT / IMPS / RTGS / BHIM UPI) — stored as
 *     ONLINE; rules only ask whether the mode contains "UPI";
 *   - cheque bank, branch and cheque date, and the Diagnostics bill total.
 *
 * Nothing is read from a report that failed its check against its own printed
 * totals (his-report-reader.js), and a layout with no verified `misColumns`
 * (the SMJ doctor-fee register) is refused rather than guessed.
 */
const XLSX = require('xlsx');
const { toText, toAmount } = require('./parse-helpers');
const { readHisReport, verificationError } = require('./his-report-reader');
const { layoutFor } = require('./his-report-layouts');
const { resolveDivision } = require('../reconciliation/matcher');

const round2 = (n) => Math.round(n * 100) / 100;
/** The IP MIS and inpatient cheque ledger single-space names ("RAMESHWAR  SUNTH" -> "RAMESHWAR SUNTH"); the Diagnostics exports do not. */
const singleSpaced = (name) => (name === null ? null : name.replace(/\s+/g, ' '));

// ---- raw cell access -------------------------------------------------------
// Dates and numbers are read from the cell VALUE, not its display text: the
// display drops seconds ("01/08/26 01:14 AM") and adds grouping commas
// ("116,743,951"), neither of which the older exports had.

// `col` is relative to the sheet's own first column, matching how
// his-report-reader.js's sheet_to_json grid (and therefore its header/section
// detection, and the layouts' column numbers) sees it — NOT the absolute
// spreadsheet letter. Most exports start at column A, where that is the same
// thing, but a real export can start at B (confirmed: DOCTOR_FEE_REG_YH.RPT in
// "ALL COLLECTIONS 01-SEP TO 15-SEP SBD.xls" has no column A at all), which
// silently shifted every field this function read one column right of what
// the layout actually named — paymentMode landing on a Speciality column,
// referenceId landing on a blank one. Same fix as his-report-reader.js's own
// row-offset handling (decode_range(...).s.r), applied to columns instead.
function cellAt(ws, excelRow, col) {
  const ref = ws['!ref'];
  const startCol = ref ? XLSX.utils.decode_range(ref).s.c : 0;
  return ws[XLSX.utils.encode_cell({ r: excelRow - 1, c: col + startCol })];
}

function rawText(cell) {
  if (!cell || cell.v === undefined || cell.v === null) return null;
  if (cell.t === 'n') return String(cell.v);
  return toText(cell.v);
}

function rawNumber(cell) {
  if (!cell || cell.v === undefined || cell.v === null || cell.v === '') return null;
  if (cell.t === 'n') return cell.v;
  return toAmount(cell.v);
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad2 = (n) => String(n).padStart(2, '0');
const isoOf = (y, m, d, H = 0, M = 0, S = 0) => `${y}-${pad2(m)}-${pad2(d)}T${pad2(H)}:${pad2(M)}:${pad2(S)}.000Z`;

/**
 * A date cell -> 'YYYY-MM-DDTHH:MM:SS.000Z', the same clock-time-as-UTC form
 * mis-parser stores. Real exports hold Excel serials; a date typed or saved as
 * text ("01-Sep-2026 0:01", "01/09/26 08:42 AM") is read too.
 */
function rawDateTime(cell) {
  if (!cell || cell.v === undefined || cell.v === null || cell.v === '') return null;
  if (cell.t === 'n') {
    const d = XLSX.SSF.parse_date_code(cell.v);
    return d ? isoOf(d.y, d.m, d.d, d.H, d.M, d.S) : null;
  }
  const text = String(cell.v).trim();
  let m = text.match(/^(\d{1,2})[- ]([A-Za-z]{3})[A-Za-z]*[- ](\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m && MONTHS[m[2].toLowerCase()]) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return isoOf(y, MONTHS[m[2].toLowerCase()], Number(m[1]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0));
  }
  m = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?/i);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    let H = Number(m[4] || 0);
    if (m[7]) H = (H % 12) + (m[7].toUpperCase() === 'PM' ? 12 : 0);
    return isoOf(y, Number(m[2]), Number(m[1]), H, Number(m[5] || 0), Number(m[6] || 0));
  }
  return null;
}

const ymdOf = (iso) => (iso ? iso.slice(0, 10) : null);
/** "08" and "26" for a receipt dated 2026-08-01 — the older exports wrap receipt numbers in them. */
const monthOf = (iso) => iso.slice(5, 7);
const yearOf = (iso) => iso.slice(2, 4);

/** "08/IDE61521/26" -> "IDE61521/26" (how the cheque ledger and refund document write it). */
const withoutMonthPrefix = (no) => no.replace(/^\d{2}\//, '');
/** "IRF119362" from "09/IRF119362" (the refund document carries no year either). */
const bareNumber = (no) => withoutMonthPrefix(no).replace(/\/\d{2}$/, '');

// ---- reading the workbook --------------------------------------------------

/**
 * Reads the reports a target needs and refuses any that failed its check
 * against its own printed totals. Returns, per report, its sheets with their
 * rows and the worksheet the raw cells are read from.
 */
function readFamilies(workbook, families = ['UCR_IP', 'UCR_OP', 'UCR_DIAG']) {
  const out = { UCR_IP: { sheets: [] }, UCR_OP: { sheets: [] }, UCR_DIAG: { sheets: [] } };
  for (const family of families) {
    const report = readHisReport(workbook, family);
    if (report.status === 'FAILED') throw verificationError(report);
    const layout = layoutFor(family);
    out[family] = {
      report,
      sheets: report.sheets.map((s) => {
        const variant = layout.variants.find((v) => v.id === s.variantId);
        return { ...s, ws: workbook.Sheets[s.sheetName], misColumns: variant ? variant.misColumns : null, variantId: s.variantId };
      }),
    };
  }
  return out;
}

/**
 * Field accessor over one data row, by the variant's misColumns. A receipt
 * date is required — the older exports build receipt numbers from it — so an
 * unreadable one stops the upload and names the row.
 */
function fieldsOf(sheet, row) {
  const cols = sheet.misColumns;
  const cell = (name) => cellAt(sheet.ws, row.excelRow, cols[name]);
  return {
    text: (name) => (cols[name] === undefined ? null : rawText(cell(name))),
    number: (name) => (cols[name] === undefined ? null : rawNumber(cell(name))),
    dateTime: (name) => {
      const value = cols[name] === undefined ? null : rawDateTime(cell(name));
      if (value === null && name === 'receiptDate') {
        const shown = cell(name) ? JSON.stringify(cell(name).w ?? cell(name).v) : 'blank';
        const err = new Error(`${sheet.sheetName} row ${row.excelRow}: the receipt date (${shown}) cannot be read as a date, so nothing was saved.`);
        err.status = 422;
        throw err;
      }
      return value;
    },
  };
}

function requireMisColumns(sheet, what) {
  if (sheet.misColumns) return;
  const err = new Error(
    `${what}: the "${sheet.sheetName}" sheet uses column layout ${sheet.variantId}, which has not yet been verified against ` +
      'an older export for this purpose, so its rows were not read. Upload the dedicated export for this unit, or send both ' +
      'files so the layout can be verified.',
  );
  err.status = 422;
  throw err;
}

function unitOf(families) {
  for (const f of Object.values(families)) for (const s of f.sheets) if (s.unitName) return s.unitName;
  return null;
}

/** Why a split-paid receipt shows as Unmatched — the same words wherever it is reported. */
const SPLIT_UPI_REASON =
  'paid in two UPI parts (UPI + ManualUPI); the report gives only the combined amount, not the amount per reference';

/**
 * The non-cash parts of one Diagnostics-sheet receipt, each with the reference
 * from its own column. A receipt paid partly by UPI and partly by transfer
 * yields two parts.
 */
function diagParts(f, heldBack, splitPaid = []) {
  const parts = [];
  const upi = f.number('upiAmt');
  if (upi) {
    const upiRef = f.text('upiRef');
    const manualRef = f.text('manualUpiRef');
    if (upiRef && manualRef) {
      // Paid partly by UPI and partly by ManualUPI: the export stored two rows
      // (e.g. 70 + 630), but this report gives only their combined amount in
      // one column. Inventing a split would be wrong — but so is leaving the
      // receipt out (2026-09-25: 3 receipts, Rs 3,517, silently missing from
      // every list and total). So it is stored ONCE, at the combined amount,
      // with BOTH references, the way the OP register already stores a bill
      // paid through two references — and it shows in the Unmatched list until
      // checked. Reported in splitPaid so the upload says so.
      parts.push({ mode: 'SPLIT_UPI', amount: upi, ref: upiRef, manualRef });
      splitPaid.push({ receiptNo: f.text('receiptNo'), amount: upi, references: [upiRef, manualRef], reason: SPLIT_UPI_REASON });
    } else if (upiRef || !manualRef) parts.push({ mode: 'UPI', amount: upi, ref: upiRef });
    else parts.push({ mode: 'MANUALUPI', amount: upi, ref: manualRef });
  }
  const online = f.number('onlineAmt');
  if (online) parts.push({ mode: 'ONLINE', amount: online, ref: f.text('onlineRef') });
  return parts;
}

const isOdeSeries = (receiptNo) => /^ODE/i.test(receiptNo);
const isRefundSeries = (receiptNo) => /^(ORF|ODF|OPF|DRF)/i.test(receiptNo);

// ---- Online Collection MIS — IP (ip_payment_records) ------------------------

/** The IP MIS carried the gateway modes' fixed labels; bank transfers carried the (unknown) bank. */
const IP_MODE_CONSTANTS = {
  UPI: { payType: 'UPI', remarks: 'UPI', paymentRemarks: 'UPI PAYMENT INTEGRATION' },
  ManualUPI: { payType: 'MANUALUPI', remarks: null, paymentRemarks: null },
  Online: { payType: null, remarks: null, paymentRemarks: null },
};

function ipRow({ receiptNumber, receiptDate, yhno, ipNo, patientName, mode, ref, manualRef = null, amount, userId, userName }) {
  const k = IP_MODE_CONSTANTS[mode];
  return {
    receiptNumber,
    receiptDate,
    yhno,
    ipNo,
    patientName,
    // UPI's RRN sat in the second transaction column; transfers and ManualUPI in the first.
    // A split-paid receipt (diagParts SPLIT_UPI) keeps its ManualUPI reference here too.
    transactionRef1: mode === 'UPI' ? manualRef : ref,
    transactionRef2: mode === 'UPI' ? ref : null,
    paymentMode: mode,
    payType: k.payType,
    remarks: k.remarks,
    paymentRemarks: k.paymentRemarks,
    patType: null,
    billAmount: amount,
    cashAmount: null,
    cardAmount: null,
    chequeAmount: null,
    onlineUpiAmount: amount,
    userId,
    userName,
  };
}

const DIAG_TO_IP_MODE = { UPI: 'UPI', MANUALUPI: 'ManualUPI', ONLINE: 'Online', SPLIT_UPI: 'UPI' };

function misIpRows(families, heldBack = [], splitPaid = []) {
  const rows = [];
  for (const sheet of families.UCR_IP.sheets) {
    requireMisColumns(sheet, 'Online Collection MIS — IP');
    for (const r of sheet.rows) {
      if (r.section !== 'Collections') continue;
      const f = fieldsOf(sheet, r);
      const mode = f.text('instrumentType');
      if (!IP_MODE_CONSTANTS[mode]) continue;
      rows.push(
        ipRow({
          receiptNumber: f.text('receiptNo'),
          receiptDate: f.dateTime('receiptDate'),
          yhno: f.text('yhNo'),
          ipNo: f.text('ipNo'),
          patientName: singleSpaced(f.text('patientName')),
          mode,
          ref: f.text('referenceId'),
          amount: f.number('amount'),
          userId: f.text('userId'),
          userName: f.text('userName'),
        }),
      );
    }
  }
  // The IP export also carried the ODE (OP advance) receipts, which the
  // combined workbook files under Diagnostics.
  for (const sheet of families.UCR_DIAG.sheets) {
    requireMisColumns(sheet, 'Online Collection MIS — IP');
    for (const r of sheet.rows) {
      const f = fieldsOf(sheet, r);
      const no = f.text('receiptNo');
      if (!isOdeSeries(no)) continue;
      const receiptDate = f.dateTime('receiptDate');
      for (const part of diagParts(f, heldBack, splitPaid)) {
        rows.push(
          ipRow({
            receiptNumber: `${monthOf(receiptDate)}/${no}/${yearOf(receiptDate)}`,
            receiptDate,
            yhno: f.text('yhNo'),
            ipNo: null,
            patientName: singleSpaced(f.text('patientName')),
            mode: DIAG_TO_IP_MODE[part.mode],
            ref: part.ref,
            manualRef: part.manualRef ?? null,
            amount: part.amount,
            userId: f.text('userId'),
            userName: f.text('userName'),
          }),
        );
      }
    }
  }
  return rows;
}

// ---- Online Collection MIS — Diagnostics / OP (diag_op_payment_records) -----

function misDiagRows(families, heldBack = [], splitPaid = []) {
  const rows = [];

  // Doctor-fee register: one MIS row per BILL. A bill is several register
  // lines (consultation, registration fee, ...) that may be paid differently:
  // the export's bill and discount cover ALL of them, its online amount only
  // the lines paid by UPI / Online (e.g. DFV1155251: an 800 consultation plus
  // a 100 registration by UPI -> bill 900, online 100, discount 800).
  for (const sheet of families.UCR_OP.sheets) {
    requireMisColumns(sheet, 'Online Collection MIS — Diagnostics / OP');
    const bills = new Map();
    for (const r of sheet.rows) {
      const f = fieldsOf(sheet, r);
      const bill = f.text('billNo');
      if (!bills.has(bill)) bills.set(bill, []);
      bills.get(bill).push(f);
    }
    for (const [bill, lines] of bills) {
      const paid = lines.filter((l) => l.text('paymentMode') === 'UPI' || l.text('paymentMode') === 'Online');
      if (!paid.length) continue;
      const first = paid[0];
      const receiptDate = first.dateTime('receiptDate');
      const ref1 = first.text('reference1');
      const ref2 = first.text('reference2');
      const online = round2(paid.reduce((s, l) => s + (l.number('netAmt') || 0), 0));
      const total = round2(lines.reduce((s, l) => s + (l.number('totAmt') || 0), 0));
      const discount = round2(lines.reduce((s, l) => s + (l.number('discAmt') || 0), 0));
      const refund = isRefundSeries(bill);
      const mode = first.text('paymentMode');
      // How the export labelled the mode, read off which reference columns it filled.
      let payMode;
      let payType;
      if (mode === 'Online') [payMode, payType] = ['ONLINE', 'ONL'];
      else if (ref1 && ref2) [payMode, payType] = [null, 'UPI'];
      else if (ref1) [payMode, payType] = ['UPI', 'UPI'];
      else [payMode, payType] = ['MANUALUPI', 'MANUALUPI'];
      rows.push({
        receiptNumber: `${bill}/${yearOf(receiptDate)}`,
        receiptDate,
        yhno: first.text('yhNo'),
        diagNo: first.text('diagNo'),
        patientName: first.text('patientName'),
        transactionRef1: ref1,
        transactionRef2: ref2,
        transactionRef3: null,
        payType,
        payMode,
        patType: first.text('patType') ? first.text('patType').toUpperCase() : null,
        // A refund bill carried its value as a positive bill and nothing as online.
        billAmount: refund ? Math.abs(total) : total,
        cashAmount: null,
        cardAmount: null,
        chequeAmount: null,
        onlineUpiAmount: refund ? 0 : online,
        discountAmount: refund ? 0 : discount,
        diffAmount: 0,
        userId: first.text('userId'),
        userName: first.text('userName'),
        department: 'OPD', // doctor-fee register (AC-10 department filter)
      });
    }
  }

  // Diagnostics advances: every series except ODE (which belongs to the IP
  // export). ORS receipts were exported without a diag number, patient
  // category or bill figures, and with the UPI reference repeated in the third
  // transaction column; ORE receipts with all of those.
  for (const sheet of families.UCR_DIAG.sheets) {
    requireMisColumns(sheet, 'Online Collection MIS — Diagnostics / OP');
    for (const r of sheet.rows) {
      const f = fieldsOf(sheet, r);
      const no = f.text('receiptNo');
      if (isOdeSeries(no)) continue;
      const receiptDate = f.dateTime('receiptDate');
      const ors = /^ORS/i.test(no);
      const refund = isRefundSeries(no);
      // The export carried the receipt's other parts beside the online one.
      const cash = f.number('cashAmt');
      const card = f.number('cardAmt');
      const chequePart = f.number('chequeAmt');
      for (const part of diagParts(f, heldBack, splitPaid)) {
        const amount = f.number('amount');
        const split = part.mode === 'SPLIT_UPI';
        rows.push({
          receiptNumber: `${no}/${yearOf(receiptDate)}`,
          receiptDate,
          yhno: f.text('yhNo'),
          diagNo: ors || refund ? null : f.text('diagNo'),
          patientName: f.text('patientName'),
          // Split-paid: ManualUPI reference first, UPI second, pay mode blank —
          // how the OP register stores a bill paid through two references.
          transactionRef1: split ? part.manualRef : null,
          transactionRef2: part.ref,
          transactionRef3: ors && part.mode === 'UPI' ? part.ref : null,
          payType: part.mode === 'ONLINE' ? 'ONL' : split ? 'UPI' : part.mode,
          payMode: split ? null : part.mode,
          patType: ors ? null : f.text('patType') ? f.text('patType').toUpperCase() : null,
          // Not the Diagnostics bill total (the export's figure), which this
          // report does not carry: the receipt's own amount.
          billAmount: ors ? null : refund ? Math.abs(amount || 0) : amount,
          cashAmount: cash ? cash : null,
          cardAmount: card ? card : null,
          chequeAmount: chequePart ? chequePart : null,
          onlineUpiAmount: refund ? 0 : part.amount,
          discountAmount: ors ? null : 0,
          diffAmount: ors ? null : 0,
          userId: f.text('userId'),
          userName: f.text('userName'),
          department: 'DIAG', // diagnostics advances report (AC-10 department filter)
        });
      }
    }
  }
  return rows;
}

// ---- Cheque collection ledger (cheque_collection_records) -------------------

function chequeRows(families) {
  const ip = [];
  const op = [];
  for (const sheet of families.UCR_IP.sheets) {
    requireMisColumns(sheet, 'Cheque collection');
    for (const r of sheet.rows) {
      if (r.section !== 'Collections') continue;
      const f = fieldsOf(sheet, r);
      if (f.text('instrumentType') !== 'Cheque') continue;
      const receiptDate = f.dateTime('receiptDate');
      ip.push({
        collectionKind: 'IP',
        receiptNumber: withoutMonthPrefix(f.text('receiptNo')),
        receiptDate: ymdOf(receiptDate),
        chequeDate: null,
        ipNo: f.text('ipNo'),
        diagNo: null,
        patientName: singleSpaced(f.text('patientName')),
        chequeNo: f.text('referenceId'),
        payType: null,
        bankName: null,
        branchName: null,
        amount: f.number('amount'),
        receiptAmount: null,
        patType: null,
        userId: f.text('userId'),
        userName: f.text('userName'),
      });
    }
  }
  for (const sheet of families.UCR_DIAG.sheets) {
    requireMisColumns(sheet, 'Cheque collection');
    for (const r of sheet.rows) {
      const f = fieldsOf(sheet, r);
      const no = f.text('receiptNo');
      const cheque = f.number('chequeAmt');
      if (!cheque || cheque < 0 || isRefundSeries(no)) continue;
      const receiptDate = f.dateTime('receiptDate');
      const row = {
        receiptNumber: `${no}/${yearOf(receiptDate)}`,
        receiptDate: ymdOf(receiptDate),
        chequeDate: null,
        ipNo: null,
        diagNo: isOdeSeries(no) ? null : f.text('diagNo'),
        patientName: f.text('patientName'),
        chequeNo: f.text('chequeRef'),
        payType: null,
        bankName: null,
        branchName: null,
        amount: cheque,
        receiptAmount: isOdeSeries(no) ? null : f.number('amount'),
        patType: null,
        userId: f.text('userId'),
        userName: f.text('userName'),
      };
      // ODE (OP advance) cheques were on the inpatient ledger, like ODE online receipts on the IP MIS.
      if (isOdeSeries(no)) ip.push({ ...row, collectionKind: 'IP' });
      else op.push({ ...row, collectionKind: 'OP' });
    }
  }
  return { ip, op };
}

// ---- Refund document (refund_records) ---------------------------------------

/**
 * A refund paid by several cheques arrives as one row, "053570,053571", with
 * their combined amount. It is stored exactly so — which is how the refund
 * document itself recorded 3 of the 4 such refunds in SBD Aug-26.
 */
function refundRows(families) {
  const unitName = unitOf(families);
  const division = resolveDivision(unitName);
  const rows = [];

  for (const sheet of families.UCR_IP.sheets) {
    requireMisColumns(sheet, 'Refund document');
    for (const r of sheet.rows) {
      if (r.section !== 'Refunds') continue;
      const f = fieldsOf(sheet, r);
      if (f.text('instrumentType') !== 'Cheque') continue;
      const amount = f.number('amount');
      const refundNo = bareNumber(f.text('receiptNo'));
      const chequeNo = f.text('referenceId');
      rows.push({
        sheetName: sheet.sheetName,
        unitName,
        division,
        refundKind: 'IP',
        refundNo,
        chequeDate: ymdOf(f.dateTime('receiptDate')),
        chequeNo,
        patientName: f.text('patientName'),
        draweeName: null,
        ipNo: f.text('ipNo'),
        diagNo: null,
        bankName: null,
        amount: amount === null ? null : Math.abs(amount),
      });
    }
  }

  // Only the ORF series: the OP refund document never carried ODF/OPF refunds.
  for (const sheet of families.UCR_DIAG.sheets) {
    requireMisColumns(sheet, 'Refund document');
    for (const r of sheet.rows) {
      const f = fieldsOf(sheet, r);
      const no = f.text('receiptNo');
      const cheque = f.number('chequeAmt');
      if (!/^ORF/i.test(no) || !cheque) continue;
      // The OP refund document writes the year suffix ("ORF18752/26"); the IP one does not.
      const refundNo = `${no}/${yearOf(f.dateTime('receiptDate'))}`;
      const chequeNo = f.text('chequeRef');
      rows.push({
        sheetName: sheet.sheetName,
        unitName,
        division,
        refundKind: 'OP',
        refundNo,
        chequeDate: ymdOf(f.dateTime('receiptDate')),
        chequeNo,
        patientName: null,
        draweeName: null,
        ipNo: null,
        diagNo: f.text('refundDiagNo'),
        bankName: null,
        amount: Math.abs(cheque),
      });
    }
  }
  return rows;
}

// ---- route-facing entry points ---------------------------------------------
// Each returns the same shape the route's own parser returns, so the route
// code after it is unchanged, plus what was held back and how it was checked.

const HIS_SHEET_NAMES = new Set(['ADVANCES_YH.RPT', 'ADVANCES_OP_YH.RPT', 'DOCTOR_FEE_REG_YH.RPT']);

/** True for a workbook holding any of the three HIS collection reports. Reads sheet names only. */
function isHisWorkbook(buffer) {
  const names = XLSX.read(buffer, { type: 'buffer', bookSheets: true }).SheetNames;
  return names.some((n) => HIS_SHEET_NAMES.has(String(n).trim().toUpperCase()));
}

const toWorkbook = (bufferOrWorkbook) =>
  bufferOrWorkbook && bufferOrWorkbook.SheetNames ? bufferOrWorkbook : XLSX.read(bufferOrWorkbook, { type: 'buffer' });

function verificationOf(families) {
  return Object.values(families)
    .filter((f) => f.report)
    .map((f) => ({ family: f.report.family, label: f.report.label, status: f.report.status }));
}

/** For POST /api/ip-payments. */
function hisIpMisUpload(bufferOrWorkbook) {
  const families = readFamilies(toWorkbook(bufferOrWorkbook), ['UCR_IP', 'UCR_DIAG']);
  const heldBack = [];
  const splitPaid = [];
  const rows = misIpRows(families, heldBack, splitPaid);
  const unitName = unitOf(families);
  return { sheets: rows.length ? [{ sheetName: 'ADVANCES_YH.RPT', unitName, rows }] : [], heldBack, splitPaid, verification: verificationOf(families) };
}

/** For POST /api/diag-op-payments. */
function hisDiagMisUpload(bufferOrWorkbook) {
  const families = readFamilies(toWorkbook(bufferOrWorkbook), ['UCR_OP', 'UCR_DIAG']);
  const heldBack = [];
  const splitPaid = [];
  const rows = misDiagRows(families, heldBack, splitPaid);
  const unitName = unitOf(families);
  return { sheets: rows.length ? [{ sheetName: 'ADVANCES_OP_YH.RPT', unitName, rows }] : [], heldBack, splitPaid, verification: verificationOf(families) };
}

/** For POST /api/cheque-collections: one sheet per collection kind, as the ledger's parser returns them. */
function hisChequeUpload(bufferOrWorkbook) {
  const families = readFamilies(toWorkbook(bufferOrWorkbook), ['UCR_IP', 'UCR_DIAG']);
  const { ip, op } = chequeRows(families);
  const unitName = unitOf(families);
  const sheets = [
    { sheetName: 'ADVANCES_YH.RPT', unitName, kind: 'IP', rows: ip },
    { sheetName: 'ADVANCES_OP_YH.RPT', unitName, kind: 'OP', rows: op },
  ].filter((sh) => sh.rows.length);
  return { sheets, skippedSheets: [], verification: verificationOf(families) };
}

/** For POST /api/refunds. */
function hisRefundUpload(bufferOrWorkbook) {
  const families = readFamilies(toWorkbook(bufferOrWorkbook), ['UCR_IP', 'UCR_DIAG']);
  const rows = refundRows(families);
  const sheets = ['IP', 'OP'].map((kind) => {
    const part = rows.filter((r) => r.refundKind === kind);
    return {
      sheetName: kind === 'IP' ? 'ADVANCES_YH.RPT' : 'ADVANCES_OP_YH.RPT',
      unitName: unitOf(families),
      division: part[0] ? part[0].division : null,
      refundKind: kind,
      rowCount: part.length,
      total: round2(part.reduce((sum, r) => sum + (r.amount || 0), 0)),
      skipped: part.length === 0,
    };
  });
  return { rows, sheets, verification: verificationOf(families) };
}

module.exports = {
  readFamilies,
  misIpRows,
  misDiagRows,
  chequeRows,
  refundRows,
  unitOf,
  isHisWorkbook,
  hisIpMisUpload,
  hisDiagMisUpload,
  hisChequeUpload,
  hisRefundUpload,
};
