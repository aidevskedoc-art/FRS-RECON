/**
 * Read-only verification of the bank statement duplicate-line check
 * (filterNewBankLines in src/online-upload/dedupe.js). Nothing is written.
 *
 *   node --env-file=.env scripts/verify-bank-line-dedupe.js
 *
 * Every real bank statement already stored is replayed as if it were uploaded
 * again, in the shape the statement parser produces:
 *   1. the SQL and JS line identities agree on every stored line;
 *   2. re-uploading a stored statement skips every line;
 *   3. a statement that overlaps nothing stores every line (the change is
 *      invisible to a normal upload);
 *   4. the same lines under another account are not skipped;
 *   5. a line repeated within one new statement is kept, twice;
 *   6. half-overlapping statement: exactly the stored half is skipped.
 */
const db = require('../src/db');
const { filterNewBankLines, bankLineIdentity } = require('../src/online-upload/dedupe');

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

/** A stored line back in the parser's shape: dates as text, amounts as numbers, blanks as null. */
function asParsed(row) {
  const num = (v) => (v === null ? null : Number(v));
  return {
    txnDate: row.txn_date,
    valueDate: row.value_date,
    narration: row.narration,
    chqRefNo: row.chq_ref_no,
    withdrawalAmt: num(row.withdrawal_amt),
    depositAmt: num(row.deposit_amt),
    closingBalance: num(row.closing_balance),
  };
}

async function main() {
  const { rows: uploads } = await db.query(`SELECT id, account_no FROM bank_statement_uploads WHERE source = 'BANK' ORDER BY id`);
  if (uploads.length === 0) {
    console.log('No bank statements stored — nothing to verify.');
    return;
  }

  let lines = 0;
  let identityMismatches = 0;
  for (const u of uploads) {
    const { rows } = await db.query(
      `SELECT to_char(txn_date, 'YYYY-MM-DD') AS txn_date, to_char(value_date, 'YYYY-MM-DD') AS value_date,
              narration, chq_ref_no, withdrawal_amt, deposit_amt, closing_balance,
              COALESCE(to_char(txn_date, 'YYYY-MM-DD'), '') || '§' || COALESCE(to_char(value_date, 'YYYY-MM-DD'), '') || '§' ||
              COALESCE(narration, '') || '§' || COALESCE(chq_ref_no, '') || '§' ||
              COALESCE(to_char(withdrawal_amt, 'FM999999999990.00'), '') || '§' ||
              COALESCE(to_char(deposit_amt, 'FM999999999990.00'), '') || '§' ||
              COALESCE(to_char(closing_balance, 'FM999999999990.00'), '') AS sql_identity
         FROM bank_statement_records WHERE batch_id = $1 ORDER BY id`,
      [u.id],
    );
    const parsed = rows.map(asParsed);
    lines += rows.length;
    identityMismatches += rows.filter((r, i) => bankLineIdentity(parsed[i]) !== r.sql_identity).length;

    const again = await filterNewBankLines({ accountNo: u.account_no, rows: parsed });
    check(`statement ${u.id} (${rows.length} lines) uploaded again: every line skipped`, again.skipped === rows.length && again.newRows.length === 0, `skipped ${again.skipped}`);

    // Nudging the running balance makes each line one that was never stored.
    const fresh = parsed.map((r) => ({ ...r, closingBalance: (r.closingBalance ?? 0) + 0.01 }));
    const fresh1 = await filterNewBankLines({ accountNo: u.account_no, rows: fresh });
    check(`statement ${u.id}: lines never stored are all kept`, fresh1.skipped === 0 && fresh1.newRows.length === rows.length, `skipped ${fresh1.skipped}`);

    const otherAccount = await filterNewBankLines({ accountNo: '999999999999999', rows: parsed });
    check(`statement ${u.id}: same lines under another account are all kept`, otherAccount.skipped === 0, `skipped ${otherAccount.skipped}`);

    if (rows.length >= 2) {
      const half = Math.floor(rows.length / 2);
      const mixed = [...parsed.slice(0, half), ...fresh.slice(half)];
      const partial = await filterNewBankLines({ accountNo: u.account_no, rows: mixed });
      check(`statement ${u.id}: half overlapping — exactly the stored half skipped`, partial.skipped === half && partial.newRows.length === rows.length - half, `skipped ${partial.skipped} of ${half}`);

      const repeated = await filterNewBankLines({ accountNo: u.account_no, rows: [fresh[0], fresh[0]] });
      check(`statement ${u.id}: a line repeated within a new statement is kept twice`, repeated.newRows.length === 2);
    }
  }
  check(`SQL and JS identities agree on all ${lines} stored lines`, identityMismatches === 0, `${identityMismatches} differ`);
}

main()
  .catch((err) => {
    failures += 1;
    console.error(err);
  })
  .finally(async () => {
    await db.pool.end();
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed.');
    process.exitCode = failures ? 1 : 0;
  });
