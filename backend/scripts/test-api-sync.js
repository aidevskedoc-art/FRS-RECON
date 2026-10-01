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

(async () => {
  console.log('api-sync');
  await testDates();
  await testSoapCall();
  testMapping();
  if (process.argv[2]) testRealOutput(process.argv[2]);
  console.log('all passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
