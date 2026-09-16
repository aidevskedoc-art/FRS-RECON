/**
 * File-type detection for the consolidated upload screen.
 *
 * The problem this solves: every upload endpoint in this app is reached by the
 * user navigating to a particular screen and tab — the *route* is how the system
 * learns what kind of file it was handed. Consolidating uploads into a few drop
 * zones removes that signal, so it has to be recovered from the file itself.
 *
 * Design, and why it is not "try every parser and see which one succeeds":
 *   - Cost. Each parser does its own XLSX.read(); files here reach 70 MB. This
 *     reads the workbook ONCE and shares the grids.
 *   - Safety. Several parsers are positional and will happily emit garbage rows
 *     from the wrong file rather than failing — parsing is not a safe probe.
 *     Signatures are explicit and reviewable instead.
 *
 * Shape follows the registry this codebase already uses for the same problem in
 * a different domain: src/extraction/formats/index.js — an ordered list where
 * the most specific signature wins. Two differences: every match is returned,
 * not just the first (one real workbook legitimately IS two types — a combined
 * bank + EaseBuzz export), and matches carry a confidence so the UI knows when
 * to ask rather than assume.
 *
 * NOTHING HERE PARSES DATA. It only identifies. The existing parsers remain the
 * only code that reads rows, and none of them are modified.
 *
 * Every signature below was built from the real files on record, not from the
 * parsers' own guesses — including the `.RPT` sheet names, which turned out to
 * be the single most reliable discriminator: each MIS/cheque export writes a
 * distinct one, which cleanly separates the two pairs that no existing code
 * could tell apart (old MIS Format 1 vs 2, and UCR OP vs DIAG).
 */
const XLSX = require('xlsx');

/**
 * Rows scanned when looking for a header row. Most exports put theirs at row
 * 0-2, under a banner line or two — but a real HDFC bank statement carries a
 * full account-details preamble first and its Date/Narration header lands at
 * row 20, so the window has to clear that. Passed to XLSX.read as `sheetRows`,
 * so a wider window costs nothing beyond these rows.
 */
const HEADER_SCAN_ROWS = 30;

/** Confidence at or above which a single match is treated as certain enough not to ask the user. */
const CONFIDENT = 70;

const norm = (v) =>
  String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\.$/, ''); // "Diag No." and "Diag No" are the same column

/** True when one row within the scan window contains every marker. */
function rowWithAll(ctx, markers) {
  const wanted = markers.map(norm);
  return ctx.rows.some((cells) => wanted.every((w) => cells.includes(w)));
}

/** True when a sheet name matches (case-insensitive, whitespace-collapsed). */
function sheetNamed(ctx, name) {
  return ctx.sheetNames.some((s) => norm(s) === norm(name));
}

/**
 * The registry. Ordered most-specific first so that, where two could both fire,
 * the tighter one is reported with higher confidence.
 *
 * `zone` maps to the three drop zones on the consolidated screen.
 * `endpoint` is the EXISTING upload route this type is confirmed to; nothing new.
 */
const SIGNATURES = [
  // ---- MIS zone: the original IP / Diag pipeline -------------------------
  {
    type: 'MIS_IP',
    label: 'MIS — IP (online & UPI collection)',
    zone: 'MIS',
    endpoint: '/api/ip-payments',
    match(ctx) {
      const bySheet = sheetNamed(ctx, 'ONLINE_PAYMENTS_IP.RPT');
      // "IPNO" + "Online Amount" are what separate this from Format 2, which
      // carries "Diag Number" + "UPI Amount" in the same positions.
      const byHeader = rowWithAll(ctx, ['slno', 'ipno', 'online amount']);
      if (bySheet && byHeader) return { confidence: 100, reason: 'sheet ONLINE_PAYMENTS_IP.RPT + IPNO/Online Amount headers' };
      if (bySheet) return { confidence: 85, reason: 'sheet named ONLINE_PAYMENTS_IP.RPT' };
      if (byHeader) return { confidence: 80, reason: 'Slno + IPNO + Online Amount headers' };
      return null;
    },
  },
  {
    type: 'MIS_DIAG',
    label: 'MIS — Diagnostics / OP (online & UPI collection)',
    zone: 'MIS',
    endpoint: '/api/diag-op-payments',
    match(ctx) {
      const bySheet = sheetNamed(ctx, 'UPI_TRANSACTIONS_OPD.RPT');
      // "Diag Number" and "Diff Amount" exist only in Format 2. This is the
      // check the MIS parser never had — sending a Format 1 file down the
      // Format 2 path silently stores a full batch of shifted garbage.
      const byHeader = rowWithAll(ctx, ['slno', 'diag number', 'upi reference number']);
      if (bySheet && byHeader) return { confidence: 100, reason: 'sheet UPI_TRANSACTIONS_OPD.RPT + Diag Number/UPI Reference Number headers' };
      if (bySheet) return { confidence: 85, reason: 'sheet named UPI_TRANSACTIONS_OPD.RPT' };
      if (byHeader) return { confidence: 80, reason: 'Slno + Diag Number + UPI Reference Number headers' };
      return null;
    },
  },

  // ---- MIS zone: the newer instrument-level HIS exports (UCR) ------------
  {
    type: 'UCR_IP',
    label: 'UPI & Card MIS — IP',
    zone: 'MIS',
    endpoint: '/api/ucr-upload/ucr-ip',
    match(ctx) {
      const bySheet = sheetNamed(ctx, 'ADVANCES_YH.RPT');
      const byHeader = rowWithAll(ctx, ['sno', 'receipt no', 'billno', 'type', 'reference id']);
      if (bySheet && byHeader) return { confidence: 100, reason: 'sheet ADVANCES_YH.RPT + Type/Reference ID headers' };
      if (bySheet) return { confidence: 85, reason: 'sheet named ADVANCES_YH.RPT' };
      if (byHeader) return { confidence: 80, reason: 'SNO + RECEIPT NO + BILLNO + Type + Reference ID headers' };
      return null;
    },
  },
  {
    type: 'UCR_OP',
    label: 'UPI & Card MIS — OP (doctor consultations)',
    zone: 'MIS',
    endpoint: '/api/ucr-upload/ucr-op',
    match(ctx) {
      const bySheet = sheetNamed(ctx, 'DOCTOR_FEE_REG_YH.RPT');
      // The tie-break against UCR_DIAG. Both files put "SNO" in column 0 — the
      // only thing the two parsers key on — so header vocabulary is what
      // actually separates them.
      const byHeader = rowWithAll(ctx, ['consultant', 'speciality', 'pmttype', 'net amt']);
      if (bySheet && byHeader) return { confidence: 100, reason: 'sheet DOCTOR_FEE_REG_YH.RPT + Consultant/Speciality/Net Amt headers' };
      if (bySheet) return { confidence: 85, reason: 'sheet named DOCTOR_FEE_REG_YH.RPT' };
      if (byHeader) return { confidence: 80, reason: 'Consultant + Speciality + PmtType + Net Amt headers' };
      return null;
    },
  },
  {
    type: 'UCR_DIAG',
    label: 'UPI & Card MIS — Diagnostics',
    zone: 'MIS',
    endpoint: '/api/ucr-upload/ucr-diag',
    match(ctx) {
      const bySheet = sheetNamed(ctx, 'ADVANCES_OP_YH.RPT');
      // The other half of the UCR_OP tie-break: the bucketed amount columns
      // and "RefId" appear only in the DIAG export.
      const byHeader = rowWithAll(ctx, ['doctor name', 'upiamt', 'onlamt', 'refid']);
      if (bySheet && byHeader) return { confidence: 100, reason: 'sheet ADVANCES_OP_YH.RPT + UPIAmt/OnlAmt/RefId headers' };
      if (bySheet) return { confidence: 85, reason: 'sheet named ADVANCES_OP_YH.RPT' };
      if (byHeader) return { confidence: 80, reason: 'Doctor Name + UPIAmt + OnlAmt + RefId headers' };
      return null;
    },
  },

  // ---- Cheque zone ------------------------------------------------------
  {
    type: 'CHEQUE_COLLECTION',
    label: 'Cheque Collection ledger',
    zone: 'CHEQUE',
    endpoint: '/api/cheque-collections',
    match(ctx) {
      // One endpoint covers both IP and OP ledgers — the existing parser works
      // out which from the sheet itself, so detection only has to say "cheque".
      const ipSheet = sheetNamed(ctx, 'CHEQUE_DETAILS_YH.RPT');
      const opSheet = sheetNamed(ctx, 'CHQ_DETAILS_OP.RPT');
      const ipHeader = rowWithAll(ctx, ['rcpt dt', 'chq dt', 'ip no', 'chq no']);
      const opHeader = rowWithAll(ctx, ['rcpt. no', 'diag. no', 'cheque.amt']);
      if ((ipSheet && ipHeader) || (opSheet && opHeader)) {
        return { confidence: 100, reason: `sheet ${ipSheet ? 'CHEQUE_DETAILS_YH.RPT' : 'CHQ_DETAILS_OP.RPT'} + cheque ledger headers` };
      }
      if (ipSheet || opSheet) return { confidence: 85, reason: `sheet named ${ipSheet ? 'CHEQUE_DETAILS_YH.RPT' : 'CHQ_DETAILS_OP.RPT'}` };
      if (ipHeader || opHeader) return { confidence: 80, reason: 'cheque ledger headers' };
      return null;
    },
  },
  {
    type: 'REFUND',
    label: 'Refund document',
    zone: 'CHEQUE',
    endpoint: '/api/refunds',
    match(ctx) {
      // Ships as one workbook with a sheet per unit ("HTC IP Refund",
      // "SMJ OP REFUNDS", …), so the sheet name is not usable here — the
      // header is. "Refund No" appears in no other export.
      if (rowWithAll(ctx, ['cheque date', 'refund no', 'cheque no'])) {
        return { confidence: 100, reason: 'Cheque Date + Refund No + Cheque No headers' };
      }
      if (rowWithAll(ctx, ['refund no'])) return { confidence: 75, reason: 'Refund No header' };
      return null;
    },
  },

  // ---- Bank / gateway zone ----------------------------------------------
  {
    type: 'BANK_STATEMENT',
    label: 'Bank statement',
    zone: 'BANK',
    endpoint: '/api/online-upload/bank-statement',
    match(ctx) {
      // The parser's own structural signature: Date+Narration at columns 0/1,
      // with rows of asterisks bracketing the transaction table. Nothing else
      // in the estate looks remotely like this.
      const headerAt01 = ctx.rows.some((cells) => cells[0] === 'date' && cells[1] === 'narration');
      const asterisks = ctx.rawRows.some((cells) => {
        const seven = cells.slice(0, 7).map((c) => String(c ?? '').trim());
        return seven.length === 7 && seven.every((c) => /^\*+$/.test(c));
      });
      if (headerAt01 && asterisks) return { confidence: 100, reason: 'Date/Narration header with asterisk marker rows' };
      if (headerAt01) return { confidence: 80, reason: 'Date + Narration in columns 1 and 2' };
      return null;
    },
  },
  {
    type: 'CARD_MPR',
    label: 'CARD MPR (card merchant payout report)',
    zone: 'BANK',
    endpoint: '/api/ucr-upload/card-mpr',
    match(ctx) {
      if (rowWithAll(ctx, ['mecode', 'app_code', 'pymt_chgamnt'])) {
        return { confidence: 100, reason: 'MECODE + APP_CODE + PYMT_CHGAMNT headers' };
      }
      return null;
    },
  },
  {
    type: 'CARD_PINELABS',
    label: 'Pine Labs POS report (AMEX / RBL_DCC)',
    zone: 'BANK',
    endpoint: '/api/ucr-upload/card-pinelabs',
    match(ctx) {
      if (rowWithAll(ctx, ['acquirer', 'approval code', 'tid'])) {
        return { confidence: 100, reason: 'Acquirer + Approval Code + TID headers' };
      }
      return null;
    },
  },
  {
    type: 'UPI_MPR',
    label: 'UPI MPR (merchant payout report)',
    zone: 'BANK',
    endpoint: '/api/ucr-upload/upi-mpr',
    match(ctx) {
      // "UPI Trxn ID" and "MSF Amount" are the tight markers. Deliberately not
      // relying on "Order ID"/"Transaction Amount" alone — PayU's parser claims
      // those too, which is the collision this ordering exists to avoid.
      if (rowWithAll(ctx, ['upi trxn id', 'txn ref no. (rrn)'])) {
        return { confidence: 100, reason: 'UPI Trxn ID + Txn ref no. (RRN) headers' };
      }
      if (rowWithAll(ctx, ['upi trxn id', 'msf amount'])) {
        return { confidence: 95, reason: 'UPI Trxn ID + MSF Amount headers' };
      }
      return null;
    },
  },
  {
    type: 'EASEBUZZ',
    label: 'EaseBuzz transaction report',
    zone: 'BANK',
    endpoint: '/api/online-upload/easebuzz',
    match(ctx) {
      // Not represented in the sample corpus — signature taken from the
      // parser's own declared header vocabulary, so treat a lone match here as
      // worth confirming rather than certain.
      if (rowWithAll(ctx, ['easebuzz id'])) return { confidence: 90, reason: 'Easebuzz ID header' };
      if (rowWithAll(ctx, ['easbuzz id'])) return { confidence: 90, reason: 'Easbuzz Id header' };
      return null;
    },
  },
  {
    type: 'EASEBUZZ_SETTLEMENT',
    label: 'EaseBuzz settlement report',
    zone: 'BANK',
    endpoint: '/api/online-upload/easebuzz-settlement',
    match(ctx) {
      // Also unrepresented in the corpus. "Settlement Id" + "Bank Id" together
      // is the pair the settlement parser keys on.
      if (rowWithAll(ctx, ['settlement id', 'bank id'])) {
        return { confidence: 90, reason: 'Settlement Id + Bank Id headers' };
      }
      return null;
    },
  },
  {
    // LAST, deliberately. This parser is the loosest in the codebase — it has a
    // loosen-on-failure fallback and accepts a row on any one of four ids, so
    // it will silently swallow a UPI MPR or EaseBuzz file. Detection therefore
    // uses markers unique to a real PayU export and never its fallback.
    type: 'PAYU_MPR',
    label: 'PayU MPR (merchant payment report)',
    zone: 'BANK',
    endpoint: '/api/online-upload/payu-mpr',
    match(ctx) {
      if (rowWithAll(ctx, ['addedon', 'bank arn', 'bank reference no'])) {
        return { confidence: 100, reason: 'AddedOn + Bank ARN + Bank Reference No headers' };
      }
      if (rowWithAll(ctx, ['addedon', 'convenience fee'])) {
        return { confidence: 85, reason: 'AddedOn + Convenience Fee headers' };
      }
      return null;
    },
  },
];

/**
 * Reads the workbook once and builds the shared context every signature sees.
 * `rows` are normalised for comparison; `rawRows` keep original text for the
 * structural checks (the bank statement's asterisk markers).
 */
function buildContext(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', sheetRows: HEADER_SCAN_ROWS });
  const rows = [];
  const rawRows = [];
  const headersSeen = new Set();

  for (const sheetName of workbook.SheetNames) {
    const grid = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: false, defval: '' });
    for (const cells of grid.slice(0, HEADER_SCAN_ROWS)) {
      rawRows.push(cells);
      const normalised = cells.map(norm);
      rows.push(normalised);
      for (const cell of normalised) if (cell) headersSeen.add(cell);
    }
  }

  return { sheetNames: workbook.SheetNames, rows, rawRows, headersSeen: [...headersSeen] };
}

/**
 * @param {Buffer} buffer an .xls/.xlsx workbook
 * @returns {{ matches: Array<{type,label,zone,endpoint,confidence,reason}>,
 *             sheetNames: string[], certain: boolean }}
 *   `matches` is ordered best-confidence-first and may be empty (unrecognised)
 *   or hold more than one entry (a genuinely multi-type workbook, or a file the
 *   caller must disambiguate). `certain` is true only when exactly one match
 *   cleared the confidence bar — the UI asks the user in every other case.
 */
function detectFileType(buffer) {
  const ctx = buildContext(buffer);

  const matches = [];
  for (const sig of SIGNATURES) {
    const hit = sig.match(ctx);
    if (!hit) continue;
    matches.push({
      type: sig.type,
      label: sig.label,
      zone: sig.zone,
      endpoint: sig.endpoint,
      confidence: hit.confidence,
      reason: hit.reason,
    });
  }
  matches.sort((a, b) => b.confidence - a.confidence);

  const confident = matches.filter((m) => m.confidence >= CONFIDENT);
  return { matches, sheetNames: ctx.sheetNames, certain: confident.length === 1 };
}

module.exports = { detectFileType, SIGNATURES, CONFIDENT };
