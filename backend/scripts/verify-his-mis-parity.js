/**
 * Read-only verification: rows rebuilt from a combined HIS workbook
 * (his-mis-rows.js) vs the rows the dedicated exports stored for the same
 * period — column by column, and through the upload routes' own duplicate
 * check. Nothing is written.
 *
 *   node --env-file=.env scripts/verify-his-mis-parity.js <workbook.xls> [ip|diag|cheque|refund]
 *
 * Batch ids of the stored exports to compare against (defaults: SBD Aug-26):
 *   IP_BATCH=55 DIAG_BATCH=48 CHEQUE_IP_BATCH=54 CHEQUE_OP_BATCH=58 REFUND_BATCHES=28,29 REFUND_UNIT=SECUNDERABAD
 *
 * Expected on SBD Aug-26 (2026-09-18): every column the matching rules read is
 * identical; the differences are what the workbook does not carry (payer/TPA,
 * bank-transfer sub-type, bank name, cheque date, Diagnostics bill total) and
 * 4 receipts held back because their UPI/ManualUPI split is not in the report.
 */
const fs = require('fs');
const XLSX = require('xlsx');
const { Pool } = require('pg');
const M = require('../src/online-upload/his-mis-rows');
const pool = new Pool();

const workbookPath = process.argv[2];
if (!workbookPath) {
  console.error('usage: node --env-file=.env scripts/verify-his-mis-parity.js <workbook.xls> [ip|diag|cheque|refund]');
  process.exit(2);
}
const env = (k, d) => process.env[k] || d;
const B = { ip: Number(env('IP_BATCH', 55)), diag: Number(env('DIAG_BATCH', 48)), chequeIp: Number(env('CHEQUE_IP_BATCH', 54)), chequeOp: Number(env('CHEQUE_OP_BATCH', 58)), refunds: env('REFUND_BATCHES', '28,29').split(',').map(Number), unit: env('REFUND_UNIT', 'SECUNDERABAD') };
const only = process.argv[3];
const t = (v) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim());
const num = (v) => (v === null || v === undefined || v === '' ? null : Math.round(Number(v) * 100) / 100);

function compare(label, oldRows, newRows, keyOf, cols) {
  console.log(`\n=== ${label}: old ${oldRows.length} rows, new ${newRows.length} rows ===`);
  const newBy = new Map();
  for (const r of newRows) { const k = keyOf.new(r); if (!newBy.has(k)) newBy.set(k, []); newBy.get(k).push(r); }
  const oldKeys = new Set();
  let missing = []; let dupKeys = 0;
  const stats = cols.map((c) => ({ ...c, eq: 0, ne: 0, ex: [] }));
  for (const o of oldRows) {
    const k = keyOf.old(o); oldKeys.add(k);
    const cand = newBy.get(k);
    if (!cand) { missing.push(k); continue; }
    if (cand.length > 1) dupKeys++;
    const n = cand[0];
    for (const s of stats) {
      const a = s.kind === 'num' ? num(o[s.old]) : t(o[s.old]);
      const b = s.kind === 'num' ? num(n[s.new]) : s.kind === 'ts' ? (n[s.new] ? n[s.new].slice(0, 19) : null) : t(n[s.new]);
      if (a === b) s.eq++; else { s.ne++; if (s.ex.length < 3) s.ex.push(`${k}: old=${JSON.stringify(a)} new=${JSON.stringify(b)}`); }
    }
  }
  const extra = newRows.filter((r) => !oldKeys.has(keyOf.new(r)));
  console.log(`  matched ${oldRows.length - missing.length}/${oldRows.length}; missing ${missing.length} ${missing.slice(0, 5).join(', ')}; extra new rows ${extra.length} ${extra.slice(0, 5).map(keyOf.new).join(', ')}; keys with >1 new row ${dupKeys}`);
  for (const s of stats) console.log(`  ${s.ne ? 'DIFF' : ' ok '} ${s.old.padEnd(18)} eq ${String(s.eq).padStart(6)} ne ${String(s.ne).padStart(6)}  ${s.ex.join(' | ').slice(0, 330)}`);
}

(async () => {
  const wb = XLSX.read(fs.readFileSync(workbookPath), { type: 'buffer' });
  const fam = M.readFamilies(wb);

  if (!only || only === 'ip') {
    const { rows: old } = await pool.query(`SELECT receipt_number, to_char(receipt_date,'YYYY-MM-DD"T"HH24:MI:SS') receipt_date, yhno, ip_no, patient_name, transaction_id_1, transaction_id_2, trans_id, payment_mode, pay_type, remarks, payment_remarks, pat_type, bill_amount, cash_amount, card_amount, cheque_amount, online_amount, user_id, user_name FROM ip_payment_records WHERE batch_id=$1`, [B.ip]);
    const rows = M.misIpRows(fam);
    compare('IP MIS', old, rows, {
      old: (o) => `${t(o.receipt_number)}§${t(o.transaction_id_1) || t(o.transaction_id_2)}`,
      new: (n) => `${t(n.receiptNumber)}§${t(n.transactionRef1) || t(n.transactionRef2)}`,
    }, [
      { old: 'receipt_date', new: 'receiptDate', kind: 'ts' }, { old: 'yhno', new: 'yhno' }, { old: 'ip_no', new: 'ipNo' }, { old: 'patient_name', new: 'patientName' },
      { old: 'transaction_id_1', new: 'transactionRef1' }, { old: 'transaction_id_2', new: 'transactionRef2' }, { old: 'payment_mode', new: 'paymentMode' },
      { old: 'pay_type', new: 'payType' }, { old: 'remarks', new: 'remarks' }, { old: 'payment_remarks', new: 'paymentRemarks' }, { old: 'pat_type', new: 'patType' },
      { old: 'bill_amount', new: 'billAmount', kind: 'num' }, { old: 'online_amount', new: 'onlineUpiAmount', kind: 'num' }, { old: 'cash_amount', new: 'cashAmount', kind: 'num' },
      { old: 'user_id', new: 'userId' }, { old: 'user_name', new: 'userName' },
    ]);
  }

  if (!only || only === 'diag') {
    const { rows: old } = await pool.query(`SELECT receipt_number, to_char(receipt_date,'YYYY-MM-DD"T"HH24:MI:SS') receipt_date, yhno, diag_no, patient_name, transaction_id_1, transaction_id_2, transaction_id_3, pay_type, pay_mode, pat_type, bill_amount, cash_amount, card_amount, cheque_amount, online_amount, discount_amount, diff_amount, user_id, user_name FROM diag_op_payment_records WHERE batch_id=$1`, [B.diag]);
    const rows = M.misDiagRows(fam);
    compare('Diagnostics/OP MIS', old, rows, {
      old: (o) => `${t(o.receipt_number)}§${t(o.transaction_id_2) || t(o.transaction_id_1)}`,
      new: (n) => `${t(n.receiptNumber)}§${t(n.transactionRef2) || t(n.transactionRef1)}`,
    }, [
      { old: 'receipt_date', new: 'receiptDate', kind: 'ts' }, { old: 'yhno', new: 'yhno' }, { old: 'diag_no', new: 'diagNo' }, { old: 'patient_name', new: 'patientName' },
      { old: 'transaction_id_1', new: 'transactionRef1' }, { old: 'transaction_id_2', new: 'transactionRef2' }, { old: 'transaction_id_3', new: 'transactionRef3' },
      { old: 'pay_type', new: 'payType' }, { old: 'pay_mode', new: 'payMode' }, { old: 'pat_type', new: 'patType' },
      { old: 'bill_amount', new: 'billAmount', kind: 'num' }, { old: 'online_amount', new: 'onlineUpiAmount', kind: 'num' }, { old: 'discount_amount', new: 'discountAmount', kind: 'num' }, { old: 'diff_amount', new: 'diffAmount', kind: 'num' },
      { old: "cash_amount", new: "cashAmount", kind: "num" }, { old: "card_amount", new: "cardAmount", kind: "num" }, { old: "cheque_amount", new: "chequeAmount", kind: "num" }, { old: "user_id", new: "userId" }, { old: "user_name", new: "userName" },
    ]);
  }

  if (!only || only === 'cheque') {
    const { ip, op } = M.chequeRows(fam);
    for (const [batch, rows, label] of [[B.chequeIp, ip, 'Cheque ledger IP'], [B.chequeOp, op, 'Cheque ledger OP']]) {
      const { rows: old } = await pool.query(`SELECT receipt_number, to_char(receipt_date,'YYYY-MM-DD') receipt_date, to_char(cheque_date,'YYYY-MM-DD') cheque_date, ip_no, diag_no, patient_name, cheque_no, pay_type, bank_name, branch_name, cheque_amount, receipt_amount, pat_type, user_id, user_name FROM cheque_collection_records WHERE batch_id=$1`, [batch]);
      compare(label, old, rows, { old: (o) => t(o.receipt_number), new: (n) => t(n.receiptNumber) }, [
        { old: 'receipt_date', new: 'receiptDate' }, { old: 'cheque_date', new: 'chequeDate' }, { old: 'ip_no', new: 'ipNo' }, { old: 'diag_no', new: 'diagNo' },
        { old: 'patient_name', new: 'patientName' }, { old: 'cheque_no', new: 'chequeNo' }, { old: 'pay_type', new: 'payType' }, { old: 'bank_name', new: 'bankName' },
        { old: 'cheque_amount', new: 'amount', kind: 'num' }, { old: 'receipt_amount', new: 'receiptAmount', kind: 'num' }, { old: 'pat_type', new: 'patType' },
        { old: 'user_id', new: 'userId' }, { old: 'user_name', new: 'userName' },
      ]);
    }
  }

  if (!only || only === 'refund') {
    const rows = M.refundRows(fam);
    const dates = rows.map((r) => r.chequeDate).filter(Boolean).sort();
    const from = dates[0]; const to = dates[dates.length - 1];
    console.log(`\n(workbook refunds span ${from} .. ${to})`);
    for (const kind of ['IP', 'OP']) {
      const { rows: old } = await pool.query(
        `SELECT refund_no, to_char(cheque_date,'YYYY-MM-DD') cheque_date, cheque_no, patient_name, drawee_name, ip_no, diag_no, bank_name, amount FROM refund_records
          WHERE batch_id = ANY($4) AND unit_name ILIKE $5 AND refund_kind=$1 AND cheque_date BETWEEN $2 AND $3`, [kind, from, to, B.refunds, `%${B.unit}%`]);
      compare(`Refund document ${kind} (old rows dated within the workbook's span)`, old, rows.filter((r) => r.refundKind === kind), { old: (o) => t(o.refund_no), new: (n) => t(n.refundNo) }, [
        { old: 'cheque_date', new: 'chequeDate' }, { old: 'cheque_no', new: 'chequeNo' }, { old: 'patient_name', new: 'patientName' }, { old: 'drawee_name', new: 'draweeName' },
        { old: 'ip_no', new: 'ipNo' }, { old: 'diag_no', new: 'diagNo' }, { old: 'bank_name', new: 'bankName' }, { old: 'amount', new: 'amount', kind: 'num' },
      ]);
    }
  }
  // Through the upload routes' own duplicate check: rows the stored exports
  // already hold are what a re-upload of the same period would skip.
  const { filterNewRows } = require('../src/online-upload/dedupe');
  const I = require('../src/online-upload/mis-identities');
  console.log("\n=== against the routes' duplicate check (whole table) ===");
  const sets = [
    ['IP MIS', I.IP_PAYMENT, M.hisIpMisUpload(wb).sheets.flatMap((s) => s.rows)],
    ['Diag MIS', I.DIAG_PAYMENT, M.hisDiagMisUpload(wb).sheets.flatMap((s) => s.rows)],
    ['Cheques', I.CHEQUE_COLLECTION, M.hisChequeUpload(wb).sheets.flatMap((s) => s.rows)],
    ['Refunds', I.REFUND, M.hisRefundUpload(wb).rows],
  ];
  for (const [label, id, rows] of sets) {
    const { newRows, skipped } = await filterNewRows({ ...id, rows });
    console.log(`  ${label.padEnd(9)} rows ${rows.length}, already stored ${skipped}, would be new ${newRows.length} ${newRows.slice(0, 4).map(id.identityOf).join(' | ')}`);
  }
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
