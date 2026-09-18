/**
 * Online (bank-transfer) extractor over the `ADVANCES_YH.RPT` sheet (IP
 * collections) — the "All Collection Types" consolidated workbook carries
 * NEFT/RTGS/IMPS rows in the same sheet as Card/UPI/Cheque (see
 * ucr-ip-parser.js), with the bank UTR in the same Reference ID column
 * Card/UPI rows use for their approval code/RRN (confirmed on real rows:
 * UTR-shaped values like "SBINR52026080137446271", "E26080113HB2Z7" — not a
 * gateway reference). These already reconcile through the primary MIS<->bank
 * CNF engine (ip_payment_records / ip_payment_matching_rules) exactly like
 * any other Online-mode IP receipt — this only gets the rows into that
 * shape, it invents no new matching logic. Mirrors the field convention of
 * real existing Online rows in that table: bill_amount = online_amount,
 * every other amount column left null, transaction_id_1 = the UTR.
 */
const XLSX = require('xlsx');
const { parseAdvancesYhGrid } = require('./advances-yh-grid');

function toOnlineRow(r) {
  return {
    receiptNumber: r.receiptNo,
    receiptDate: r.receiptDate,
    yhno: r.yhNo,
    ipNo: r.ipNo,
    patientName: r.patientName,
    transactionRef1: r.referenceId,
    paymentMode: 'Online',
    billAmount: r.amount,
    onlineUpiAmount: r.amount,
    userId: r.userId,
    userName: r.userName,
  };
}

function parseIpOnlineGrid(grid) {
  const parsed = parseAdvancesYhGrid(grid);
  if (!parsed) return null;
  const rows = parsed.rows.filter((r) => r.instrumentType === 'ONLINE').map(toOnlineRow);
  return { ...parsed, rows };
}

function parseIpOnlineWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });

  const rows = [];
  const mappedColumns = new Set();
  const fileHeaders = new Set();
  const sheetsParsed = [];
  const sheetsSkipped = [];
  let unitName = null;

  for (const sheetName of workbook.SheetNames) {
    const grid = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: false, defval: '' });
    const parsed = parseIpOnlineGrid(grid);
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
      'Could not find any Online rows in this IP file — expected columns like "Receipt No", "Type", "Reference ID". ' +
        'Send the file and I will add its column names.',
    );
  }

  return { rows, unitName, mappedColumns: [...mappedColumns], fileHeaders: [...fileHeaders], sheetsParsed, sheetsSkipped };
}

module.exports = { parseIpOnlineWorkbook, parseIpOnlineGrid };
