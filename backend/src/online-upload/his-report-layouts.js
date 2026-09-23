/**
 * Layout registry for the three instrument-level HIS collection reports.
 *
 * CONFIGURATION, NOT CODE. Everything here is a fact about a real export,
 * verified against real files; the reader (his-report-reader.js) is generic and
 * knows nothing about any one report. A new layout variant, a renamed sheet or
 * a new payment type is an edit to this file.
 *
 * Why column POSITIONS and not header text: in every one of these exports the
 * header labels do not sit above the data they describe (the client's own
 * annotated Aug-26 copy marks its corrected row "Changed the Headings"), and the
 * shift differs between units — the SBD doctor-fee register carries a
 * "User Name" column the SMJ one does not. Header text is therefore only used
 * to recognise a row AS a header, never to locate a field.
 *
 * Why several variants can coexist safely: a variant is only accepted when every
 * section it reads reconciles, to the rupee, with the control totals the report
 * prints about itself. A wrong column map cannot pass that — it is how the right
 * variant is chosen, and how a changed format is caught instead of ingested.
 *
 * Verified corpus:
 *   SMJ standalone  SEP-222/{IP,OP,DIAG} FROM 01-SEP TO 06-SEP.xls
 *   SBD combined    All Collection Types Single Report -Aug-26 SBD.xls
 *   SBD combined    All Collections 01.09.26 to 15.09.26 -SBD.xls
 */

/** A report's own serial number: "1", "999", "1,000" (the Diag export formats it). */
const SERIAL = /^\d{1,3}(,\d{3})+$|^\d+$/;

const HIS_REPORT_LAYOUTS = [
  {
    family: 'UCR_IP',
    label: 'IP Collection and Refunds',
    sheetNames: ['ADVANCES_YH.RPT'],
    // Used only when the sheet has been renamed.
    headerMarkers: ['sno', 'receipt no', 'billno', 'type', 'reference id'],
    keyField: 'receiptNo',
    // One row per receipt/refund number on every export seen; a repeat means a doubled export.
    uniqueKey: true,
    variants: [
      {
        id: 'ip-2026',
        note: 'User ID + User Name + Reference ID (the SMJ standalone and SBD Aug / 01-15 Sep exports).',
        // Totals cannot tell this layout from ip-2026-single-user (same amount
        // column); these checks can — see that variant.
        checks: { requireAnyValue: ['referenceId'] },
        columns: {
          receiptNo: 1,
          receiptDate: 3,
          yhNo: 4,
          ipNo: 5,
          patientName: 6,
          billNo: 10,
          instrumentType: 11,
          amount: 12,
          userId: 13,
          userName: 14,
          referenceId: 15,
        },
        // Positions for building the older MIS / cheque / refund rows
        // (his-mis-rows.js), verified field by field against the stored SBD
        // Aug-26 Online Collection MIS and cheque ledger.
        misColumns: {
          receiptNo: 1,
          receiptDate: 3,
          yhNo: 4,
          ipNo: 5,
          patientName: 6,
          instrumentType: 11,
          amount: 12,
          userId: 13,
          userName: 14,
          referenceId: 15,
        },
      },
      {
        // SECUNDERABAD "COLLECTIONS FROM 12-SEP TO 18-SEP.xls" (Sep-26): the
        // header has a single "USER" column and no "User Name", so Reference
        // ID sits at 14 and nothing is at 15. Read with ip-2026 it reconciled
        // to the rupee while storing every UPI RRN / card approval code /
        // cheque number as the user's NAME — 905 of 920 IP collections then
        // had no reference and nothing matched. Amounts are identical in both
        // layouts, so the checks below are what choose between them.
        id: 'ip-2026-single-user',
        note: 'Single USER column, no User Name (SBD Sep-26 12-18 Sep export, and the 01-15 Sep SBD combined workbook). Reference ID one column left of ip-2026.',
        checks: {
          // Nothing beyond the reference: ip-2026's Reference ID column is empty here.
          blankColumns: [15],
          // A digit-only check rejected a real 01-15 Sep export outright: 2 of
          // 3,733 genuine card approval codes are letters only (no digit).
          // Uniqueness is the reliable signal instead — see his-report-reader.js's
          // mostlyUnique check for the verification this threshold is based on.
          mostlyUnique: { referenceId: { min: 0.5 } },
        },
        columns: {
          receiptNo: 1,
          receiptDate: 3,
          yhNo: 4,
          ipNo: 5,
          patientName: 6,
          billNo: 10,
          instrumentType: 11,
          amount: 12,
          userId: 13,
          referenceId: 14,
        },
        misColumns: {
          receiptNo: 1,
          receiptDate: 3,
          yhNo: 4,
          ipNo: 5,
          patientName: 6,
          instrumentType: 11,
          amount: 12,
          userId: 13,
          referenceId: 14,
        },
      },
    ],
    amountFields: ['amount'],
    vocabularies: {
      // SECUNDERABAD's Sep-26 export spells the Card row "C Card" throughout
      // (574/2013 rows, zero plain "Card" rows) — the same label the OP
      // report's own net-summary line already used ("Cash Amt | C Card Amt").
      instrumentType: { values: ['Cash', 'Card', 'UPI', 'Online', 'Cheque', 'ManualUPI'], allowBlank: false, aliases: { 'C Card': 'Card' } },
    },
    // "TOTAL COLLECTION :" closes the collections, "TOTAL REFUNDS :" the refunds.
    footer: { match: /TOTAL\s+(COLLECTION|REFUNDS)/i, sectionName: (text) => (/REFUNDS/i.test(text) ? 'Refunds' : 'Collections') },
    summary: { match: /Net\s+Amt|Net\s+Cash\s+Collection/i },
    controlTotals: {
      total: { field: 'amount' },
      // The report folds ManualUPI into its UPI figure.
      buckets: [
        { name: 'Cash', field: 'amount', where: { instrumentType: ['Cash'] } },
        { name: 'Card', field: 'amount', where: { instrumentType: ['Card'] }, sections: ['Collections'] },
        { name: 'Cheque', field: 'amount', where: { instrumentType: ['Cheque'] } },
        { name: 'UPI (incl. ManualUPI)', field: 'amount', where: { instrumentType: ['UPI', 'ManualUPI'] } },
        { name: 'Online', field: 'amount', where: { instrumentType: ['Online'] } },
      ],
      // The refunds footer prints no card figure at all (the cell is blank on
      // every export seen), so refund card rows are covered by the section total.
    },
  },

  {
    family: 'UCR_OP',
    label: 'OP Consultations, Registrations, Collection and Refunds',
    sheetNames: ['DOCTOR_FEE_REG_YH.RPT'],
    headerMarkers: ['consultant', 'speciality', 'pmttype', 'net amt'],
    keyField: 'billNo',
    variants: [
      {
        id: 'op-smj',
        note: 'No "User Name" column (SMJ). The PmtType/PatType/Payment labels sit one column left of their data.',
        // Its Net Amt (15) is where op-sbd-2026 keeps it too, so the printed
        // totals can't tell the two apart — and on an op-sbd-2026 file this
        // layout reads the User Name as the reference (that stored 4,791
        // cashier names as Card/UPI references, Secunderabad Sep-26). A real
        // reference always has a digit; a name never does.
        checks: { valuePattern: { referenceIdPrimary: /\d/ } },
        columns: {
          billNo: 1,
          yhNo: 2,
          receiptDate: 3,
          patientName: 5,
          paymentMode: 9,
          netAmt: 15,
          userId: 16,
          referenceIdPrimary: 17,
          referenceIdFallback: 19,
        },
      },
      {
        id: 'op-sbd-2026',
        note:
          'SBD Sep-26 export: the op-sbd columns with one fewer column before Net Amt, so everything from Net Amt ' +
          'onward sits one column left — Net Amt 15, User ID 16, User Name 17, Reference 18 (repeated at 19; an ' +
          'Online payment\'s reference is only at 19), card approval code 20, Diag No 22.',
        // Verified against all 11,225 rows of "COLLECTIONS FROM 12-SEP TO 18-SEP.xls"
        // (Secunderabad), 2026-09-21: Tot Amt − Disc = Net Amt on every row but one
        // (a source-data quirk: Tot 500, Disc 500, Net 500); User Name is text with no
        // digit on every row; 3,600 of 3,601 UPI rows carry a 12-digit RRN at 18
        // repeated at 19 (the other a 15-digit UPI reference); all 1,190 card rows
        // carry an approval code at 20; Diag No numeric throughout; plus the report's
        // own printed totals on Net Amt. Not yet compared field by field against a
        // separate dedicated Diagnostics/OP MIS export, as op-sbd was.
        checks: { valuePattern: { referenceIdPrimary: /\d/, userName: /^[^\d]+$/ } },
        columns: {
          billNo: 1,
          yhNo: 2,
          receiptDate: 3,
          patientName: 5,
          paymentMode: 9,
          netAmt: 15,
          userId: 16,
          userName: 17,
          referenceIdPrimary: 18,
          referenceIdFallback: 20,
        },
        misColumns: {
          billNo: 1,
          yhNo: 2,
          receiptDate: 3,
          patientName: 5,
          paymentMode: 9,
          patType: 10,
          totAmt: 13,
          discAmt: 14,
          netAmt: 15,
          userId: 16,
          userName: 17,
          reference1: 18,
          reference2: 19,
          diagNo: 22,
        },
      },
      {
        id: 'op-sbd',
        note: 'Carries a "User Name" column (SBD), shifting everything from Net Amt onward one column right. Card approval codes land at 21.',
        checks: { valuePattern: { referenceIdPrimary: /\d/ } },
        columns: {
          billNo: 1,
          yhNo: 2,
          receiptDate: 3,
          patientName: 5,
          paymentMode: 9,
          netAmt: 16,
          userId: 17,
          referenceIdPrimary: 19,
          referenceIdFallback: 21,
        },
        // Verified against the stored SBD Aug-26 Diagnostics/OP MIS. The SMJ
        // layout has no old export on record to verify against, so it carries
        // no misColumns and his-mis-rows.js refuses it rather than guessing.
        misColumns: {
          billNo: 1,
          yhNo: 2,
          receiptDate: 3,
          patientName: 5,
          paymentMode: 9,
          patType: 10,
          totAmt: 13,
          discAmt: 14,
          netAmt: 16,
          userId: 17,
          userName: 18,
          reference1: 19,
          reference2: 20,
          diagNo: 23,
        },
      },
    ],
    amountFields: ['netAmt'],
    vocabularies: {
      // Blank = a credit / corporate bill: nothing was collected at the counter.
      // "C Card": see the same alias on UCR_IP.instrumentType above.
      paymentMode: { values: ['Cash', 'Card', 'UPI', 'Online', 'Cheque'], allowBlank: true, aliases: { 'C Card': 'Card' } },
    },
    // "Cash Amount | Card Amt | …" closes consultations, "Refund Amount | …" the
    // refunds. The final "Cash Amt | C Card Amt | …" line is the net summary.
    footer: { match: /\b(Cash Amount|Refund Amount)\b/i, sectionName: (text) => (/Refund Amount/i.test(text) ? 'Refunds' : 'Collections') },
    summary: { match: /\bCash Amt\b/i },
    controlTotals: {
      total: { field: 'netAmt' },
      buckets: [
        { name: 'Cash', field: 'netAmt', where: { paymentMode: ['Cash'] } },
        { name: 'Card', field: 'netAmt', where: { paymentMode: ['Card'] } },
        { name: 'UPI', field: 'netAmt', where: { paymentMode: ['UPI'] } },
        { name: 'Online', field: 'netAmt', where: { paymentMode: ['Online'] } },
        // The report's "Credit Amt": bills with no counter payment mode.
        { name: 'Credit (no payment mode)', field: 'netAmt', where: { paymentMode: [''] } },
      ],
      // A bill carries one row per line item (consultation + registration fee
      // share a bill number), so bill numbers are NOT unique here.
    },
  },

  {
    family: 'UCR_DIAG',
    label: 'Diagnostics / OP Advances and Refunds',
    sheetNames: ['ADVANCES_OP_YH.RPT'],
    headerMarkers: ['doctor name', 'upiamt', 'onlamt', 'refid'],
    keyField: 'receiptNo',
    uniqueKey: true,
    variants: [
      {
        id: 'diag-2026',
        note: 'Amount block is Cash, Card, Cheque, Adjustment, UPI, Online, Amount at 12-18 — four columns right of its labels.',
        columns: {
          receiptNo: 1,
          receiptDate: 2,
          yhNo: 3,
          patientName: 6,
          cashAmt: 12,
          cardAmt: 13,
          chequeAmt: 14,
          adjAmt: 15,
          upiAmt: 16,
          onlineAmt: 17,
          amount: 18,
          cardReference: 20,
          userId: 24,
          userName: 25,
        },
        // The reference column depends on the instrument: cheque 19, card 20,
        // bank transfer 21, ManualUPI 22, UPI 23 — each confirmed against the
        // stored SBD Aug-26 MIS (12,356 UPI / 276 ManualUPI / 211 transfer rows,
        // every one in exactly that column).
        misColumns: {
          receiptNo: 1,
          receiptDate: 2,
          yhNo: 3,
          diagNo: 4,
          // Refund-series rows (ORF) carry their diag number one column right.
          refundDiagNo: 5,
          patientName: 6,
          patType: 11,
          cashAmt: 12,
          cardAmt: 13,
          chequeAmt: 14,
          upiAmt: 16,
          onlineAmt: 17,
          amount: 18,
          chequeRef: 19,
          onlineRef: 21,
          manualUpiRef: 22,
          upiRef: 23,
          userId: 24,
          userName: 25,
        },
      },
    ],
    amountFields: ['cashAmt', 'cardAmt', 'chequeAmt', 'adjAmt', 'upiAmt', 'onlineAmt', 'amount'],
    vocabularies: {},
    // Each receipt series (ODE, ODF/OPF, ORE, ORF, ORR/ORS) is closed by an
    // unlabelled subtotal line; a labelled "Cash Amt | Card Amt | …" line ends the sheet.
    footer: { numericOnly: true, minNumbers: 4, sectionName: null },
    summary: { match: /\bCash Amt\b/i },
    controlTotals: {
      total: { field: 'amount' },
      buckets: [
        { name: 'Cash', field: 'cashAmt' },
        { name: 'Card', field: 'cardAmt' },
        { name: 'Cheque', field: 'chequeAmt' },
        { name: 'Adjustment', field: 'adjAmt' },
        { name: 'UPI', field: 'upiAmt' },
        { name: 'Online', field: 'onlineAmt' },
      ],
    },
  },
];

function layoutFor(family) {
  const layout = HIS_REPORT_LAYOUTS.find((l) => l.family === family);
  if (!layout) throw new Error(`No HIS report layout registered for "${family}"`);
  return layout;
}

module.exports = { HIS_REPORT_LAYOUTS, layoutFor, SERIAL };
