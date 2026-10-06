/**
 * HIS API sync (src/api-sync) without a database or the real HIS server:
 *
 *   1. callSoapApi through a fake transport that answers like the HIS service
 *      (raw JSON, then an empty SOAP envelope) — checks the request envelope,
 *      the SOAPAction header, XML escaping, and that the key never leaks.
 *   2. The seeded row filter + field mapping turn HIS rows into exactly the
 *      record shape his-mis-rows.js builds from the Excel workbook.
 *
 *   node scripts/test-api-sync.js [path/to/real-api-output.txt]
 *
 * With a path, the real output is also checked (counts, totals, mapping errors).
 */
const assert = require('assert');
const fs = require('fs');
const { callSoapApi, extractJson } = require('../src/api-sync/soap-client');
const { filterRows, mapRows, formatRequestDate, parseDateParts } = require('../src/api-sync/apply-mapping');
const { SEEDS } = require('../src/api-sync/seed-configs');
const { CHEQUE_COLLECTION, REFUND } = require('../src/online-upload/mis-identities');

// Keep in step with the seed in sql/schema.sql (api_configs / api_field_mappings).
const ROW_FILTER = [
  { field: 'BILL_IND', op: 'in', values: ['D'] },
  { field: 'CNCL_IND', op: 'in', values: ['N'] },
  { field: 'TCD_CHQ_BANK', op: 'in', values: ['UPI', 'ONL', 'MANUALUPI'] },
];
const MAPPINGS = [
  { dbColumn: 'receipt_number', sourceField: 'BILL_SEQ', transform: 'RECEIPT_MONTH_PREFIX', transformArg: { dateField: 'BILL_DT', dateFormat: 'dd-MM-yyyy HH:mm:ss' } },
  { dbColumn: 'receipt_date', sourceField: 'BILL_DT', transform: 'DATETIME', transformArg: { format: 'dd-MM-yyyy HH:mm:ss' } },
  { dbColumn: 'yhno', sourceField: 'PIN', transform: 'DIRECT' },
  { dbColumn: 'ip_no', sourceField: 'ADM_NO', transform: 'DIRECT' },
  { dbColumn: 'patient_name', sourceField: 'NAME', transform: 'TRIM_SPACES' },
  { dbColumn: 'transaction_id_1', sourceField: 'TCD_ONLINE_TRANS_ID', transform: 'DIRECT', condition: { field: 'TCD_CHQ_BANK', op: 'notIn', values: ['UPI'] } },
  { dbColumn: 'transaction_id_2', sourceField: 'UPI_CHECK_REFID', transform: 'DIRECT' },
  { dbColumn: 'payment_mode', sourceField: 'TCD_CHQ_BANK', transform: 'LOOKUP', transformArg: { map: { UPI: 'UPI', MANUALUPI: 'ManualUPI', ONL: 'Online' } } },
  { dbColumn: 'pay_type', sourceField: 'TCD_CHQ_BANK', transform: 'LOOKUP', transformArg: { map: { UPI: 'UPI', MANUALUPI: 'MANUALUPI' } } },
  { dbColumn: 'remarks', sourceField: 'TCD_CHQ_BANK', transform: 'LOOKUP', transformArg: { map: { UPI: 'UPI' } } },
  { dbColumn: 'payment_remarks', sourceField: 'TCD_CHQ_BANK', transform: 'LOOKUP', transformArg: { map: { UPI: 'UPI PAYMENT INTEGRATION' } } },
  { dbColumn: 'bill_amount', sourceField: 'TR_CH_AMT', transform: 'NUMBER' },
  { dbColumn: 'online_amount', sourceField: 'TR_CH_AMT', transform: 'NUMBER' },
  { dbColumn: 'user_id', sourceField: 'BILL_USR', transform: 'DIRECT' },
  { dbColumn: 'user_name', sourceField: 'APP_USR_NAME', transform: 'TRIM_SPACES' },
];

const row = (o) => ({
  BILL_SEQ: '', ADM_NO: '1', BILL_IND: 'D', CNCL_IND: 'N', BILL_DT: '03-03-2026 10:00:00',
  CASH_AMT: '0', CARD_AMT: '0', CHEQUE_AMT: '0', BILL_USR: 'BL1', NAME: 'X', TR_CH_AMT: '0',
  ORG_COMM: '', TCD_CHQ_BANK: '', BILL_SEQ_NO: '', PIN: '6001', RD_INV_NO: '', IH_INV_NO: '',
  CCD_AUTH_NO: '', CD_CHQ_NO: '', TCD_ONLINE_TRANS_ID: '', UPI_CHECK_REFID: '', APP_USR_NAME: 'USER  ONE', EBZ_CREATED_BY: '',
  ...o,
});

const FIXTURE_ROWS = [
  row({ BILL_SEQ: 'IDE11591/26', ADM_NO: '94421', BILL_DT: '03-03-2026 11:55:01', NAME: 'MURALI  SUNDARAM ', TR_CH_AMT: '4221', TCD_CHQ_BANK: 'ONL', TCD_ONLINE_TRANS_ID: '603379867219', PIN: '600075768' }),
  row({ BILL_SEQ: 'IDE11563/26', TR_CH_AMT: '8154', TCD_CHQ_BANK: 'UPI', TCD_ONLINE_TRANS_ID: '119423648206', UPI_CHECK_REFID: '119423648206' }),
  row({ BILL_SEQ: 'IDE11600/26', TR_CH_AMT: '500', TCD_CHQ_BANK: 'MANUALUPI', TCD_ONLINE_TRANS_ID: '661196017928' }),
  row({ BILL_SEQ: 'IDE11648/26', CARD_AMT: '84793', CCD_AUTH_NO: '198938' }), // card — not an IP online row
  row({ BILL_SEQ: 'IDE11564/26', CASH_AMT: '5940' }), // cash
  row({ BILL_SEQ: 'IRF9351', BILL_IND: 'F', CHEQUE_AMT: '50000', CD_CHQ_NO: '023360' }), // refund
  row({ BILL_SEQ: 'IDE11700/26', TR_CH_AMT: '100', TCD_CHQ_BANK: 'UPI', CNCL_IND: 'Y', UPI_CHECK_REFID: '1' }), // cancelled
];

const SOAP_TAIL =
  '<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"><soap:Body><IpCollectionResponse xmlns="http://tempuri.org/" /></soap:Body></soap:Envelope>';

const KEY = 'TEST-KEY-not-real-123';
const CONFIG = {
  name: 'IpCollection', soap_method: 'IpCollection', soap_namespace: 'http://tempuri.org/',
  soap_action: 'http://tempuri.org/IpCollection', auth_param: 'htuayek', date_param: 'trandate', loc_param: 'loc',
  date_format: 'dd/MM/yyyy', response_root: 'IPcollectionv', total_field: 'Total', timeout_ms: 5000, authKey: KEY,
};

/** A transport that answers like the HIS service without opening a socket. */
const fakeTransport = (answer) => {
  const calls = [];
  const fn = async (url, body, options) => {
    calls.push({ url, body, options });
    return answer(body);
  };
  fn.calls = calls;
  return fn;
};

async function testDates() {
  assert.strictEqual(formatRequestDate('2026-03-13', 'dd/MM/yyyy'), '13/03/2026');
  assert.strictEqual(formatRequestDate('2026-03-13', 'MM/dd/yyyy'), '03/13/2026');
  assert.strictEqual(formatRequestDate('2026-03-13', 'dd-MMM-yyyy'), '13-Mar-2026');
  assert.deepStrictEqual(parseDateParts('13-03-2026 21:05:09', 'dd-MM-yyyy HH:mm:ss'), { y: 2026, m: 3, d: 13, H: 21, M: 5, S: 9 });
  assert.deepStrictEqual(parseDateParts('13-03-2026', 'dd-MM-yyyy HH:mm:ss'), { y: 2026, m: 3, d: 13, H: 0, M: 0, S: 0 });
  assert.strictEqual(parseDateParts('2026/13/03', 'dd-MM-yyyy HH:mm:ss'), null);
  console.log('  ok dates');
}

async function testSoapCall() {
  const url = 'https://his.example/Service.asmx?op=IpCollection';
  const ok = fakeTransport(() => ({
    status: 200,
    text: JSON.stringify({ Total: String(FIXTURE_ROWS.length), IPcollectionv: FIXTURE_ROWS }, null, 4) + SOAP_TAIL,
  }));
  const out = await callSoapApi({ ...CONFIG, url, tls_insecure: true }, { locValue: 9, dateValue: '03/03/2026' }, ok);
  const [call] = ok.calls;
  assert.strictEqual(call.url, url);
  assert.strictEqual(call.options.soapAction, 'http://tempuri.org/IpCollection');
  assert.strictEqual(call.options.tlsInsecure, true);
  assert.strictEqual(call.options.timeoutMs, 5000);
  assert.match(call.body, /<IpCollection xmlns="http:\/\/tempuri.org\/"><loc>9<\/loc><trandate>03\/03\/2026<\/trandate><htuayek>TEST-KEY-not-real-123<\/htuayek><\/IpCollection>/);
  assert.strictEqual(out.rows.length, FIXTURE_ROWS.length);
  assert.strictEqual(out.total, FIXTURE_ROWS.length);

  // A value with XML characters is escaped, not injected.
  const esc = fakeTransport(() => ({ status: 200, text: '{"Total":"0","IPcollectionv":[]}' }));
  await callSoapApi({ ...CONFIG, url, authKey: 'a<b>&"c' }, { locValue: 9, dateValue: '03/03/2026' }, esc);
  assert.match(esc.calls[0].body, /<htuayek>a&lt;b&gt;&amp;&quot;c<\/htuayek>/);

  // An error page that echoes the request must not leak the key.
  const echo = fakeTransport((body) => ({ status: 500, text: `bad request ${body}` }));
  await assert.rejects(callSoapApi({ ...CONFIG, url }, { locValue: 9, dateValue: '03/03/2026' }, echo), (err) => {
    assert.match(err.message, /HTTP 500/);
    assert.ok(!err.message.includes(KEY), 'key leaked into the error message');
    return true;
  });

  // A network failure that mentions the key is redacted too.
  const down = async () => {
    throw new Error(`socket hang up while sending ${KEY}`);
  };
  await assert.rejects(callSoapApi({ ...CONFIG, url }, { locValue: 9, dateValue: '03/03/2026' }, down), (err) => {
    assert.match(err.message, /Could not reach the API/);
    assert.ok(!err.message.includes(KEY));
    return true;
  });

  // Only the operations that read collections may be called, and the SOAPAction (which is what an ASMX
  // service goes by) must name the same one as the body. Refused before anything is sent.
  const sent = ok.calls.length;
  await assert.rejects(callSoapApi({ ...CONFIG, url, soap_method: 'SavePatient', soap_action: 'http://tempuri.org/SavePatient' }, { locValue: 9, dateValue: '03/03/2026' }, ok), (err) => err.status === 422 && /not an HIS operation this app may call/.test(err.message));
  await assert.rejects(callSoapApi({ ...CONFIG, url, soap_action: 'http://tempuri.org/SavePatient' }, { locValue: 9, dateValue: '03/03/2026' }, ok), (err) => err.status === 422 && /does not name the operation "IpCollection"/.test(err.message));
  assert.strictEqual(ok.calls.length, sent);

  // A well-behaved service: JSON inside <MethodResult>.
  const wrapped = `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><IpCollectionResponse xmlns="http://tempuri.org/"><IpCollectionResult>{&quot;Total&quot;:&quot;0&quot;,&quot;IPcollectionv&quot;:[]}</IpCollectionResult></IpCollectionResponse></soap:Body></soap:Envelope>`;
  assert.deepStrictEqual(extractJson(wrapped, 'IpCollection'), { Total: '0', IPcollectionv: [] });
  // A SOAP fault is reported, not parsed.
  assert.throws(() => extractJson('<soap:Envelope><soap:Body><soap:Fault><faultstring>Invalid key</faultstring></soap:Fault></soap:Body></soap:Envelope>', 'IpCollection'), /Invalid key/);
  console.log('  ok soap call');
}

function testMapping() {
  const kept = filterRows(FIXTURE_ROWS, ROW_FILTER);
  assert.deepStrictEqual(kept.map((r) => r.BILL_SEQ), ['IDE11591/26', 'IDE11563/26', 'IDE11600/26']);
  const { records, errors } = mapRows(kept, MAPPINGS, 'ip_payment_records');
  assert.deepStrictEqual(errors, []);

  // Same shape as his-mis-rows.js ipRow() for an Online, a UPI and a ManualUPI receipt.
  assert.deepStrictEqual(records[0], {
    receiptNumber: '03/IDE11591/26', receiptDate: '2026-03-03T11:55:01.000Z', yhno: '600075768', ipNo: '94421',
    patientName: 'MURALI SUNDARAM', transactionRef1: '603379867219', transactionRef2: null,
    paymentMode: 'Online', payType: null, remarks: null, paymentRemarks: null, patType: null,
    billAmount: 4221, cashAmount: null, cardAmount: null, chequeAmount: null, onlineUpiAmount: 4221,
    userId: 'BL1', userName: 'USER ONE',
  });
  assert.strictEqual(records[1].paymentMode, 'UPI');
  assert.strictEqual(records[1].transactionRef1, null);
  assert.strictEqual(records[1].transactionRef2, '119423648206');
  assert.strictEqual(records[1].payType, 'UPI');
  assert.strictEqual(records[1].paymentRemarks, 'UPI PAYMENT INTEGRATION');
  assert.strictEqual(records[2].paymentMode, 'ManualUPI');
  assert.strictEqual(records[2].payType, 'MANUALUPI');
  assert.strictEqual(records[2].transactionRef1, '661196017928');

  // Bad values are reported per row, not silently stored.
  const bad = mapRows([{ ...kept[0], TR_CH_AMT: 'abc', BILL_DT: 'yesterday' }], MAPPINGS, 'ip_payment_records');
  assert.ok(bad.errors.some((e) => e.column === 'bill_amount'));
  assert.ok(bad.errors.some((e) => e.column === 'receipt_date'));
  console.log('  ok mapping');
}

/** The filter operators and transforms beyond in / notIn and plain NUMBER. */
function testOperatorsAndTransforms() {
  const rows = [
    row({ BILL_SEQ: 'IDE1/26', CARD_AMT: '84793', CCD_AUTH_NO: '198938' }),
    row({ BILL_SEQ: 'IDE2/26', CASH_AMT: '5940' }),
    row({ BILL_SEQ: 'IRF3', BILL_IND: 'F', CHEQUE_AMT: '-50000', CD_CHQ_NO: '023360' }),
    row({ BILL_SEQ: 'ODE4/26', CARD_AMT: '', CASH_AMT: '10.50', CHEQUE_AMT: '1,200' }),
    row({ BILL_SEQ: 'IDE5/26', CARD_AMT: 'n/a' }),
  ];
  const seqs = (rule) => filterRows(rows, [rule]).map((r) => r.BILL_SEQ);

  // "This row has a card amount" — every row carries the column, "0" where unused.
  assert.deepStrictEqual(seqs({ field: 'CARD_AMT', op: 'nonZero', values: [] }), ['IDE1/26']);
  assert.deepStrictEqual(seqs({ field: 'CHEQUE_AMT', op: 'nonZero', values: [] }), ['IRF3', 'ODE4/26']);
  // A blank is zero; text that is not a number is neither zero nor non-zero.
  assert.deepStrictEqual(seqs({ field: 'CARD_AMT', op: 'isZero', values: [] }), ['IDE2/26', 'IRF3', 'ODE4/26']);
  assert.deepStrictEqual(seqs({ field: 'BILL_SEQ', op: 'startsWith', values: ['ODE', 'IRF'] }), ['IRF3', 'ODE4/26']);
  assert.deepStrictEqual(seqs({ field: 'BILL_SEQ', op: 'notStartsWith', values: ['ODE', 'IRF'] }), ['IDE1/26', 'IDE2/26', 'IDE5/26']);
  // An empty prefix list matches nothing (startsWith) / excludes nothing (notStartsWith).
  assert.deepStrictEqual(seqs({ field: 'BILL_SEQ', op: 'startsWith', values: [] }), []);
  assert.strictEqual(seqs({ field: 'BILL_SEQ', op: 'notStartsWith', values: [''] }).length, rows.length);
  // The two original operators are unchanged.
  assert.deepStrictEqual(seqs({ field: 'BILL_IND', op: 'in', values: ['F'] }), ['IRF3']);
  assert.strictEqual(seqs({ field: 'BILL_IND', op: 'notIn', values: ['F'] }).length, 4);

  const one = (source, transform, transformArg) =>
    mapRows([source], [{ dbColumn: 'bill_amount', sourceField: transformArg?.fields ? null : 'AMT', transform, transformArg }], 'ip_payment_records');
  const value = (...args) => one(...args).records[0].billAmount;
  const required = (e) => e.column !== 'bill_amount'; // receipt_number / receipt_date are unmapped here

  assert.strictEqual(value({ AMT: '-50000' }, 'NUMBER_ABS'), 50000);
  assert.strictEqual(value({ AMT: '50,000.50' }, 'NUMBER_ABS'), 50000.5);
  assert.strictEqual(value({ AMT: '1628' }, 'NUMBER_NEGATIVE'), -1628);
  assert.strictEqual(value({ AMT: '-1628' }, 'NUMBER_NEGATIVE'), -1628);
  assert.ok(Object.is(value({ AMT: '0' }, 'NUMBER_NEGATIVE'), 0), 'zero must stay 0, not -0');
  assert.strictEqual(value({ AMT: '' }, 'NUMBER_ABS'), null);
  assert.ok(one({ AMT: 'abc' }, 'NUMBER_NEGATIVE').errors.some((e) => e.column === 'bill_amount' && /not a number/.test(e.message)));

  // A sum reads its own list of fields: no source field, and still applied.
  const sumArg = { fields: ['CASH_AMT', 'CARD_AMT', 'CHEQUE_AMT'] };
  assert.strictEqual(value({ CASH_AMT: '10.50', CARD_AMT: '', CHEQUE_AMT: '1,200' }, 'SUM', sumArg), 1210.5);
  assert.strictEqual(value({ CASH_AMT: '0.1', CARD_AMT: '0.2', CHEQUE_AMT: '0' }, 'SUM', sumArg), 0.3);
  assert.strictEqual(value({}, 'SUM', sumArg), 0);
  const badSum = one({ CASH_AMT: '5', CARD_AMT: 'n/a', CHEQUE_AMT: '0' }, 'SUM', sumArg);
  assert.deepStrictEqual(badSum.errors.filter((e) => !required(e)), [{ index: 0, column: 'bill_amount', message: 'CARD_AMT "n/a" is not a number' }]);

  // One row per bill, and a bill's lines added up — a call that sends a row per LINE (the OP register).
  const lines = [
    { BILL: 'B1', REF: 'r1', MODE: 'UPI', PRICE: '1000', PAID: '1000', CNCL: 'N' },
    { BILL: 'B1', REF: 'r1', MODE: 'UPI', PRICE: '100', PAID: '100', CNCL: 'N' },
    { BILL: 'B2', REF: 'r2', MODE: 'UPI', PRICE: '500', PAID: '500', CNCL: 'N' },
    { BILL: 'B2', REF: 'r3', MODE: 'UPI', PRICE: '50', PAID: '50', CNCL: 'N' }, // a second payment on the same bill
    { BILL: 'B3', REF: '', MODE: 'CASH', PRICE: '800', PAID: '0', CNCL: 'N' },
    { BILL: 'B3', REF: 'r4', MODE: 'UPI', PRICE: '200', PAID: '200', CNCL: 'N' },
    { BILL: 'B3', REF: 'r4', MODE: 'UPI', PRICE: '75', PAID: '75', CNCL: 'Y' }, // a cancelled line
  ];
  const UPI = { field: 'MODE', op: 'in', values: ['UPI'] };
  const LIVE = { field: 'CNCL', op: 'in', values: ['N'] };
  const bills = (...rules) => filterRows(lines, rules).map((r) => `${r.BILL}/${r.REF}/${r.PRICE}`);
  // The first row for each value — after the other rules, wherever in the list the rule stands.
  assert.deepStrictEqual(bills({ field: 'BILL', op: 'oncePer', values: [] }, UPI, LIVE), ['B1/r1/1000', 'B2/r2/500', 'B3/r4/200']);
  // Its "values" are further fields the rows must share: one row per bill AND payment.
  assert.deepStrictEqual(bills(UPI, LIVE, { field: 'BILL', op: 'oncePer', values: ['REF'] }), ['B1/r1/1000', 'B2/r2/500', 'B2/r3/50', 'B3/r4/200']);
  assert.strictEqual(filterRows(lines, [{ field: 'BILL', op: 'oncePer', values: [] }]).length, 3);
  // As a mapping's own condition it tests nothing.
  const kept = filterRows(lines, [UPI, LIVE, { field: 'BILL', op: 'oncePer', values: ['REF'] }]);
  const sumOver = (same, where) => ({ dbColumn: 'bill_amount', sourceField: null, transform: 'SUM_SAME', transformArg: { field: 'PRICE', same, ...(where ? { where } : {}) } });
  const paidOver = { dbColumn: 'online_amount', sourceField: null, transform: 'SUM_SAME', transformArg: { field: 'PAID', same: ['BILL', 'REF'], where: [LIVE] } };
  const totals = (mapping) => mapRows(kept, [mapping, paidOver], 'ip_payment_records', lines).records.map((r) => [r.billAmount, r.onlineUpiAmount]);
  // Over EVERY received row of the bill — the cash line too — and only the lines of this row's own payment.
  assert.deepStrictEqual(totals(sumOver(['BILL'], [LIVE])), [[1100, 1100], [550, 500], [550, 50], [1000, 200]]);
  // Without the "leave out" rule the cancelled line counts.
  assert.deepStrictEqual(totals(sumOver(['BILL'])).at(-1), [1075, 200]);
  // With no other rows given, a row's "bill" is the rows it was stored from.
  assert.deepStrictEqual(mapRows(kept, [sumOver(['BILL'])], 'ip_payment_records').records.map((r) => r.billAmount), [1000, 550, 550, 200]);
  const badLine = mapRows(kept.slice(0, 1), [sumOver(['BILL'])], 'ip_payment_records', [...lines, { BILL: 'B1', PRICE: 'n/a' }]);
  assert.deepStrictEqual(badLine.errors.filter((e) => !required(e)), [{ index: 0, column: 'bill_amount', message: 'PRICE "n/a" is not a number' }]);
  console.log('  ok operators and transforms');
}

function testRealOutput(file) {
  const json = extractJson(fs.readFileSync(file, 'utf8'), 'IpCollection');
  const rows = json.IPcollectionv;
  assert.strictEqual(Number(json.Total), rows.length, 'Total does not match the rows received');
  const kept = filterRows(rows, ROW_FILTER);
  const { records, errors } = mapRows(kept, MAPPINGS, 'ip_payment_records');
  assert.deepStrictEqual(errors, [], `mapping errors: ${JSON.stringify(errors.slice(0, 5))}`);
  const byMode = records.reduce((m, r) => ({ ...m, [r.paymentMode]: (m[r.paymentMode] || 0) + 1 }), {});
  const sum = records.reduce((n, r) => n + r.onlineUpiAmount, 0);
  const ids = new Set(records.map((r) => `${r.receiptNumber}§${r.transactionRef1 || r.transactionRef2 || ''}`));
  assert.strictEqual(ids.size, records.length, 'two rows share a duplicate-check identity');
  assert.ok(records.every((r) => /^\d{2}\/(IDE)\d+\/\d{2}$/.test(r.receiptNumber)), 'unexpected receipt number shape');
  console.log(`  ok real output: ${rows.length} received, ${records.length} kept ${JSON.stringify(byMode)}, online total ${sum.toLocaleString('en-IN')}`);
}

/** The configs the app seeds (seed-configs.js) over the same real answer: what each would store, and in what shape. */
function testRealSeeds(file) {
  const rows = extractJson(fs.readFileSync(file, 'utf8'), 'IpCollection').IPcollectionv;
  const SHAPE = {
    ucr_ip_records: (r) => /^\d{2}\/IDE\d+\/\d{2}$/.test(r.receiptNo) && !!r.referenceId && /^\d{4}-\d{2}-\d{2}$/.test(r.receiptDate),
    cheque_collection_records: (r) => /^IDE\d+\/\d{2}$/.test(r.receiptNumber) && !!r.chequeNo && /^\d{4}-\d{2}-\d{2}$/.test(r.receiptDate),
    refund_records: (r) => /^IRF\d+$/.test(r.refundNo) && !!r.chequeNo && /^\d{4}-\d{2}-\d{2}$/.test(r.chequeDate),
  };
  // Cheques and refunds are told apart by these when a later sync or file repeats them; Card / UPI rows may repeat.
  const IDENTITY = { cheque_collection_records: CHEQUE_COLLECTION.identityOf, refund_records: REFUND.identityOf };

  for (const seed of SEEDS.filter((s) => s.connection.soap_method === 'IpCollection')) {
    const kept = filterRows(rows, seed.rowFilter);
    const { records, errors } = mapRows(kept, seed.mappings, seed.targetTable);
    assert.deepStrictEqual(errors, [], `${seed.name}: mapping errors: ${JSON.stringify(errors.slice(0, 5))}`);
    const odd = records.filter((r) => !SHAPE[seed.targetTable](r) || !(r.amount > 0));
    assert.strictEqual(odd.length, 0, `${seed.name}: ${odd.length} row(s) of an unexpected shape, e.g. ${JSON.stringify({ ...odd[0], patientName: undefined, yhNo: undefined })}`);
    const identityOf = IDENTITY[seed.targetTable];
    if (identityOf) assert.strictEqual(new Set(records.map(identityOf)).size, records.length, `${seed.name}: two rows share a duplicate-check identity`);
    const total = records.reduce((n, r) => n + r.amount, 0);
    console.log(`  ok real output, ${seed.name}: ${records.length} kept, total ${total.toLocaleString('en-IN')}`);
  }
}

(async () => {
  console.log('api-sync');
  await testDates();
  await testSoapCall();
  testMapping();
  testOperatorsAndTransforms();
  if (process.argv[2]) {
    testRealOutput(process.argv[2]);
    testRealSeeds(process.argv[2]);
  }
  console.log('all passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
