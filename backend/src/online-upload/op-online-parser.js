/**
 * Online (bank-transfer) extractor over the `DOCTOR_FEE_REG_YH.RPT` sheet
 * (Doctor Fee / OP registration) — the "All Collection Types" consolidated
 * workbook carries NEFT/RTGS/IMPS rows in the same sheet as Card/UPI (see
 * ucr-op-parser.js), sharing UPI's reference slot (confirmed: never
 * populated alongside Card's slot, always the only one filled on a real
 * Online row — see doctor-fee-reg-grid.js). Doctor Fee data belongs on the
 * OP side of the primary MIS<->bank CNF engine (diag_op_payment_records /
 * diag_payment_matching_rules) exactly like any other Online-mode OP
 * receipt — this only gets the rows into that shape, it invents no new
 * matching logic. Mirrors the field convention of real existing Online rows
 * in that table: bill_amount = online_amount, pay_mode = 'ONLINE' (the exact
 * casing already used there), every other amount column left null.
 *
 * Only runs on the branch variant whose Online reference position is
 * verified (currently SECUNDERABAD/SBD) — see doctor-fee-reg-grid.js.
 */
const XLSX = require('xlsx');
const { parseDoctorFeeRegGrid } = require('./doctor-fee-reg-grid');

function toOnlineRow(r) {
  return {
    receiptNumber: r.billNo,
    receiptDate: r.receiptDate,
    yhno: r.yhNo,
    patientName: r.patientName,
    transactionRef1: r.referenceId,
    payMode: 'ONLINE',
    billAmount: r.amount,
    onlineUpiAmount: r.amount,
    userId: r.userId,
    userName: r.userName,
  };
}

function parseOpOnlineGrid(grid) {
  const parsed = parseDoctorFeeRegGrid(grid);
  if (!parsed) return null;
  const rows = parsed.rows.filter((r) => r.instrumentType === 'ONLINE' && r.referenceId).map(toOnlineRow);
  return { ...parsed, rows };
}

function parseOpOnlineWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });

  const rows = [];
  const mappedColumns = new Set();
  const fileHeaders = new Set();
  const sheetsParsed = [];
  const sheetsSkipped = [];
  let unitName = null;

  for (const sheetName of workbook.SheetNames) {
    const grid = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: false, defval: '' });
    const parsed = parseOpOnlineGrid(grid);
    if (!parsed || parsed.rows.length === 0) {
      sheetsSkipped.push(sheetName);
      continue;
    }
    sheetsParsed.push(sheetName);
    unitName = unitName || parsed.unitName;
    for (const r of parsed.rows) rows.push(r);
    for (const c of parsed.mappedColumns) mappedColumns.add(c);
    for (const h of parsed.fileHeaders) fileHeaders.add(h);
  }

  if (rows.length === 0) {
    throw new Error(
      'Could not find any Online rows in this OP file — expected a header row starting with "SNO", on a branch whose ' +
        'Online reference column position is verified. Send the file and I will add its column layout.',
    );
  }

  return { rows, unitName, mappedColumns: [...mappedColumns], fileHeaders: [...fileHeaders], sheetsParsed, sheetsSkipped };
}

module.exports = { parseOpOnlineWorkbook, parseOpOnlineGrid };
