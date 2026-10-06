/**
 * Dry run of every upload the HIS collection reports feed, for the
 * consolidated upload screen.
 *
 * Tells the person, BEFORE anything is saved, exactly what a file will
 * contribute to each pipeline: which report and unit it is, whether every
 * section reconciled with the report's own printed totals, how many rows will
 * be stored, what was read but is not used there (and why), which receipts
 * are held back for review, and what is already stored from an earlier file.
 *
 * It calls the SAME functions the upload routes call, and counts "already
 * stored" with the same identity the routes skip on (mis-identities.js), so the
 * preview cannot promise something the upload does not do. Read-only.
 */
const XLSX = require('xlsx');
const { readHisReport, verificationSummary } = require('./his-report-reader');
const { ucrIpRowsFrom } = require('./ucr-ip-parser');
const { ucrOpRowsFrom } = require('./ucr-op-parser');
const { ucrDiagRowsFrom } = require('./ucr-diag-parser');
const { splitStoredRows, overlapWhere, OVERLAP_KEYS } = require('./ucr-overlap');
const { isHisWorkbook, hisIpMisUpload, hisDiagMisUpload, hisChequeUpload, hisRefundUpload } = require('./his-mis-rows');
const { filterNewRows } = require('./dedupe');
const identities = require('./mis-identities');

const round2 = (n) => Math.round(n * 100) / 100;

/** UPI & Card: the report itself. */
const UCR_TYPES = {
  UCR_IP: { rowsFrom: ucrIpRowsFrom, source: 'IP' },
  UCR_OP: { rowsFrom: ucrOpRowsFrom, source: 'OP' },
  UCR_DIAG: { rowsFrom: ucrDiagRowsFrom, source: 'DIAG' },
};

/** The older pipelines, rebuilt from the report (his-mis-rows.js). */
const MIS_TYPES = {
  MIS_IP: {
    upload: hisIpMisUpload,
    identity: identities.IP_PAYMENT,
    rowsOf: (u) => u.sheets.flatMap((s) => s.rows),
    groupOf: (r) => r.paymentMode,
    amountOf: (r) => r.onlineUpiAmount,
    note:
      'Payer (TPA) and the bank-transfer sub-type (NEFT / RTGS / IMPS / BHIM) are not in this report and are stored blank, ' +
      'so the International rule (payer contains "INT") cannot apply to these receipts.',
  },
  MIS_DIAG: {
    upload: hisDiagMisUpload,
    identity: identities.DIAG_PAYMENT,
    rowsOf: (u) => u.sheets.flatMap((s) => s.rows),
    groupOf: (r) => r.payMode || 'UPI (doctor fee)',
    amountOf: (r) => r.onlineUpiAmount,
    note:
      'Bank transfers are stored as ONLINE (the report does not say NEFT / IMPS / RTGS / BHIM UPI), and a Diagnostics ' +
      'receipt\'s bill amount is its own amount — the report carries no bill total.',
  },
  CHEQUE_COLLECTION: {
    upload: hisChequeUpload,
    identity: identities.CHEQUE_COLLECTION,
    // __unit: a cheque's identity includes its unit, as the upload route tags it.
    rowsOf: (u) => u.sheets.flatMap((s) => s.rows.map((r) => ({ ...r, __unit: s.unitName }))),
    groupOf: (r) => `${r.collectionKind} cheques`,
    amountOf: (r) => r.amount,
    note: 'Bank, branch, cheque date and payer (TPA) are not in this report and are left blank.',
  },
  REFUND: {
    upload: hisRefundUpload,
    identity: identities.REFUND,
    rowsOf: (u) => u.rows,
    groupOf: (r) => `${r.refundKind} refunds`,
    amountOf: (r) => r.amount,
    note: 'Cheque refunds only, as the refund document holds; bank and drawee are not in this report.',
  },
};

const UCR_NOTE =
  'From this report only the Card and UPI rows are stored here, for UPI & Card reconciliation. The same file also ' +
  'feeds the Online Collection MIS, cheque and refund uploads listed alongside.';

const hasPreview = (type) => Object.prototype.hasOwnProperty.call(UCR_TYPES, type) || Object.prototype.hasOwnProperty.call(MIS_TYPES, type);

function byGroup(rows, groupOf, amountOf) {
  const groups = new Map();
  for (const r of rows) {
    const key = groupOf(r);
    const g = groups.get(key) || { type: key, rows: 0, amount: 0 };
    g.rows += 1;
    g.amount = round2(g.amount + (amountOf(r) || 0));
    groups.set(key, g);
  }
  return [...groups.values()];
}

function periodOf(dates) {
  const d = dates.filter(Boolean).map((x) => String(x).slice(0, 10)).sort();
  return d.length ? { from: d[0], to: d[d.length - 1] } : null;
}

function failedPreview(family, message) {
  return {
    family,
    status: 'FAILED',
    unitNames: [],
    period: null,
    sheets: [],
    ingest: { rows: 0, amount: 0, byType: [] },
    notUsed: [],
    overlap: null,
    alreadyStored: null,
    heldBack: [],
    splitPaid: [],
    notes: [message],
  };
}

async function previewUcr(workbook, type, opts) {
  const { rowsFrom, source } = UCR_TYPES[type];
  const report = readHisReport(workbook, type);
  const summary = verificationSummary(report);
  // A FAILED sheet's rows are not trustworthy, so nothing is counted from it.
  const read = report.status === 'FAILED' ? { rows: [], notUsed: [] } : rowsFrom(report);
  const { notUsed } = read;
  let rows = read.rows;

  // Transactions already stored from an earlier (overlapping) file are
  // skipped and only the new ones stored — what the upload route does.
  let alreadyStored = null;
  const notes = [UCR_NOTE];
  if (opts.checkOverlap !== false && rows.length) {
    try {
      const split = await splitStoredRows(source, rows, OVERLAP_KEYS[source]);
      if (split.skipped) {
        alreadyStored = { rows: split.skipped };
        notes.push(`${split.skipped} of these rows are already stored (${overlapWhere(split.overlap)}) and will be skipped.`);
      }
      rows = split.newRows;
    } catch (err) {
      notes.push(`Could not check for already-stored rows: ${err.message}`);
    }
  }
  const withoutReference = rows.filter((r) => !r.referenceId).length;
  if (withoutReference) {
    notes.push(`${withoutReference} Card/UPI row(s) carry no reference number, so they cannot be matched to a gateway row and will show as unmatched.`);
  }

  return {
    family: type,
    status: report.status,
    unitNames: [...new Set(report.sheets.map((s) => s.unitName).filter(Boolean))],
    period: periodOf(rows.map((r) => r.receiptDate)),
    sheets: summary.sheets,
    ingest: { rows: rows.length, amount: round2(rows.reduce((s, r) => s + (r.amount || 0), 0)), byType: byGroup(rows, (r) => r.instrumentType, (r) => r.amount) },
    notUsed,
    overlap: null,
    alreadyStored,
    heldBack: [],
    splitPaid: [],
    notes,
  };
}

async function previewMis(workbook, type, opts) {
  const spec = MIS_TYPES[type];
  let built;
  try {
    built = spec.upload(workbook);
  } catch (err) {
    return failedPreview(type, err.message);
  }
  let rows = spec.rowsOf(built);
  const heldBack = built.heldBack || [];
  const splitPaid = built.splitPaid || [];
  const notes = [spec.note];

  let alreadyStored = null;
  if (opts.checkOverlap !== false && rows.length) {
    try {
      const { newRows, skipped } = await filterNewRows({ ...spec.identity, rows });
      alreadyStored = { rows: skipped };
      rows = newRows;
      if (skipped) notes.push(`${skipped} of these rows are already stored from an earlier upload and will be skipped.`);
    } catch (err) {
      notes.push(`Could not check for already-stored rows: ${err.message}`);
    }
  }
  if (heldBack.length) {
    notes.push(`${heldBack.length} receipt(s) held back for review — see below; they are not stored.`);
  }
  if (splitPaid.length) {
    notes.push(`${splitPaid.length} receipt(s) paid in two UPI parts are stored with both references and will show as Unmatched until checked — see below.`);
  }

  const statuses = (built.verification || []).map((v) => v.status);
  const status = statuses.includes('UNVERIFIED') ? 'UNVERIFIED' : 'VERIFIED';
  const units = [...new Set(rows.map((r) => r.unitName).filter(Boolean))];
  const unitNames = units.length ? units : [...new Set((built.sheets || []).map((s) => s.unitName).filter(Boolean))];

  return {
    family: type,
    status,
    unitNames,
    period: periodOf(rows.map((r) => r.receiptDate || r.chequeDate)),
    sheets: [],
    ingest: { rows: rows.length, amount: round2(rows.reduce((s, r) => s + (spec.amountOf(r) || 0), 0)), byType: byGroup(rows, spec.groupOf, spec.amountOf) },
    notUsed: [],
    overlap: null,
    alreadyStored,
    heldBack,
    splitPaid,
    notes,
  };
}

/**
 * Adds a `preview` to every match of one file that has one. The workbook is
 * read once and shared; a preview that throws becomes a FAILED preview rather
 * than failing the whole file.
 *
 * @param {Buffer} buffer
 * @param {Array<{type:string}>} matches detectFileType(...).matches
 * @param {{ checkOverlap?: boolean }} [opts] checkOverlap:false skips the database (tests)
 */
async function attachHisPreviews(buffer, matches, opts = {}) {
  const ucr = matches.filter((m) => UCR_TYPES[m.type]);
  const mis = matches.filter((m) => MIS_TYPES[m.type]);
  // An old-format MIS / cheque / refund export has no preview; only the HIS
  // reports (and what is rebuilt from them) do.
  if (!ucr.length && !(mis.length && isHisWorkbook(buffer))) return matches;

  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer' });
  } catch (err) {
    return matches.map((m) => (hasPreview(m.type) ? { ...m, preview: failedPreview(m.type, `Could not open this workbook: ${err.message}`) } : m));
  }
  const out = [];
  for (const m of matches) {
    if (!hasPreview(m.type)) {
      out.push(m);
      continue;
    }
    try {
      const preview = UCR_TYPES[m.type] ? await previewUcr(workbook, m.type, opts) : await previewMis(workbook, m.type, opts);
      out.push({ ...m, preview });
    } catch (err) {
      out.push({ ...m, preview: failedPreview(m.type, `Could not read this report: ${err.message}`) });
    }
  }
  return out;
}

/** True when a preview leaves nothing for a person to look at. */
function previewIsClean(p) {
  return (
    p.status === 'VERIFIED' &&
    p.ingest.rows > 0 &&
    !(p.overlap && p.overlap.rows) &&
    !(p.heldBack && p.heldBack.length) &&
    p.sheets.every((s) => s.problems.length === 0)
  );
}

/**
 * A combined HIS workbook matches up to seven types at once, which the
 * detector alone reports as "not certain". When every match has a clean
 * preview, there is nothing left for a person to decide.
 */
function allPreviewsClean(matches) {
  return matches.length > 0 && matches.every((m) => m.preview && previewIsClean(m.preview));
}

module.exports = { attachHisPreviews, allPreviewsClean, previewIsClean, hasPreview, UCR_TYPES, MIS_TYPES };
