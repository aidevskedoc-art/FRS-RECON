/**
 * The API Configs that ship with the app beyond the first (IpCollection, which
 * sql/schema.sql seeds): the other stores the same HIS call feeds.
 *
 * Every one is seeded INACTIVE. Go-live is on — stored rows cannot be deleted —
 * so a config stores nothing until an Admin has checked it with Test on the
 * API Config screen and switched it on.
 *
 * Seeded once each: api_config_seeds records the key, so a config an Admin
 * later edits, renames or deletes is never put back by a restart.
 *
 * A seeded config copies its connection settings from the config that already
 * calls the same method, so the two share that call and its key
 * (sync-unit-day.js, config-store.js withAuthKey). The settings written here
 * are used only when there is no such config.
 *
 * The mappings were written against a real IpCollection answer (Secunderabad,
 * 15-Sep-2026: 370 rows). What it showed, and what each mapping relies on:
 *   - one row per receipt, carrying ONE payment type (never two);
 *   - a refund is BILL_IND = F, numbered "IRF119652" (no month, no year), with
 *     a POSITIVE amount;
 *   - a collection is BILL_IND = D, numbered "IDE74978/26";
 *   - a card's approval code is CCD_AUTH_NO, a cheque's number CD_CHQ_NO, a
 *     UPI payment's RRN UPI_CHECK_REFID.
 * Card and UPI REFUNDS were not in that answer, so no config stores them yet.
 */

const DT = 'dd-MM-yyyy HH:mm:ss';

/** The api_configs columns that make two configs share a call, plus the timeout. */
const CONNECTION_COLUMNS = [
  'url', 'soap_action', 'soap_method', 'soap_namespace', 'auth_param', 'date_param', 'date_format',
  'loc_param', 'response_root', 'total_field', 'timeout_ms', 'tls_insecure',
];

const IP_COLLECTION = {
  url: 'https://yhapi.yashodahospital.com:8021/Service.asmx?op=IpCollection',
  soap_action: 'http://tempuri.org/IpCollection',
  soap_method: 'IpCollection',
  soap_namespace: 'http://tempuri.org/',
  auth_param: 'htuayek',
  date_param: 'trandate',
  date_format: 'dd/MM/yyyy',
  loc_param: 'loc',
  response_root: 'IPcollectionv',
  total_field: 'Total',
  timeout_ms: 60000,
  tls_insecure: false,
};

const COLLECTION = { field: 'BILL_IND', op: 'in', values: ['D'] };
const REFUND = { field: 'BILL_IND', op: 'in', values: ['F'] };
const NOT_CANCELLED = { field: 'CNCL_IND', op: 'in', values: ['N'] };
const nonZero = (field) => ({ field, op: 'nonZero', values: [] });

const constant = (dbColumn, value) => ({ dbColumn, sourceField: null, transform: 'CONSTANT', transformArg: { value }, condition: null });
const field = (dbColumn, sourceField, transform = 'DIRECT', transformArg = null) => ({ dbColumn, sourceField, transform, transformArg, condition: null });

/** "IDE74978/26" -> "09/IDE74978/26", as the IP report prints a receipt number. */
const receiptWithMonth = (dbColumn) => field(dbColumn, 'BILL_SEQ', 'RECEIPT_MONTH_PREFIX', { dateField: 'BILL_DT', dateFormat: DT });
const dateOnly = (dbColumn) => field(dbColumn, 'BILL_DT', 'DATE', { format: DT });

/** One row per instrument, as ucr-ip-parser.js stores the IP report's Card and UPI rows. */
const cardUpiRow = (instrumentType, amountField, referenceField) => [
  constant('mis_source', 'IP'),
  constant('instrument_type', instrumentType),
  receiptWithMonth('receipt_no'),
  dateOnly('receipt_date'),
  field('amount', amountField, 'NUMBER'),
  field('reference_id', referenceField),
  field('yh_no', 'PIN'),
  field('ip_no', 'ADM_NO'),
  field('patient_name', 'NAME'),
  field('user_id', 'BILL_USR'),
  field('user_name', 'APP_USR_NAME'),
];

const SEEDS = [
  {
    key: 'ip-card',
    name: 'IP Card',
    description: 'IP collections paid by card, for Card / UPI reconciliation. Reads the IpCollection call.',
    connection: IP_COLLECTION,
    targetTable: 'ucr_ip_records',
    rowFilter: [COLLECTION, NOT_CANCELLED, nonZero('CARD_AMT')],
    mappings: cardUpiRow('CARD', 'CARD_AMT', 'CCD_AUTH_NO'),
  },
  {
    key: 'ip-upi',
    name: 'IP UPI',
    description: 'IP collections paid by UPI, for Card / UPI reconciliation. Reads the IpCollection call.',
    connection: IP_COLLECTION,
    targetTable: 'ucr_ip_records',
    rowFilter: [COLLECTION, NOT_CANCELLED, { field: 'TCD_CHQ_BANK', op: 'in', values: ['UPI'] }],
    mappings: cardUpiRow('UPI', 'TR_CH_AMT', 'UPI_CHECK_REFID'),
  },
  {
    // his-mis-rows.js chequeRows(): no month prefix on the receipt, the date
    // without its time, the cheque number as the reference.
    key: 'ip-cheques',
    name: 'IP Cheques',
    description: 'IP collections paid by cheque, for cheque reconciliation. Reads the IpCollection call.',
    connection: IP_COLLECTION,
    targetTable: 'cheque_collection_records',
    rowFilter: [COLLECTION, NOT_CANCELLED, nonZero('CHEQUE_AMT')],
    mappings: [
      constant('collection_kind', 'IP'),
      field('receipt_number', 'BILL_SEQ'),
      dateOnly('receipt_date'),
      field('cheque_no', 'CD_CHQ_NO'),
      field('cheque_amount', 'CHEQUE_AMT', 'NUMBER'),
      field('ip_no', 'ADM_NO'),
      field('patient_name', 'NAME', 'TRIM_SPACES'),
      field('user_id', 'BILL_USR'),
      field('user_name', 'APP_USR_NAME'),
    ],
  },
  {
    // his-mis-rows.js refundRows(): cheque refunds only, the refund number
    // bare, the amount positive whichever sign it arrives with.
    key: 'ip-cheque-refunds',
    name: 'IP Cheque refunds',
    description: 'IP refunds paid by cheque — the evidence for contra entries. Reads the IpCollection call.',
    connection: IP_COLLECTION,
    targetTable: 'refund_records',
    rowFilter: [REFUND, NOT_CANCELLED, nonZero('CHEQUE_AMT')],
    mappings: [
      constant('refund_kind', 'IP'),
      field('refund_no', 'BILL_SEQ'),
      dateOnly('cheque_date'),
      field('cheque_no', 'CD_CHQ_NO'),
      field('amount', 'CHEQUE_AMT', 'NUMBER_ABS'),
      field('patient_name', 'NAME'),
      field('ip_no', 'ADM_NO'),
    ],
  },
];

/**
 * Adds each config in SEEDS that has never been seeded here. Safe to run on
 * every start. Each config is its own transaction: the key is claimed and the
 * config written together, or neither.
 * @returns {Promise<string[]>} the names of the configs created by this call
 */
async function seedApiConfigs() {
  // Loaded here, not at the top: SEEDS is also read by scripts that have no database.
  const db = require('../db');
  const created = [];
  for (const seed of SEEDS) {
    const added = await db.withTransaction(async (client) => {
      const claimed = await client.query(
        'INSERT INTO api_config_seeds (seed_key) VALUES ($1) ON CONFLICT DO NOTHING RETURNING seed_key',
        [seed.key],
      );
      if (!claimed.rows[0]) return false;
      // An Admin already has a config of this name: theirs stands.
      const named = await client.query('SELECT id FROM api_configs WHERE name = $1', [seed.name]);
      if (named.rows[0]) return false;

      const { rows } = await client.query(
        'SELECT * FROM api_configs WHERE soap_method = $1 ORDER BY (auth_key_enc IS NOT NULL) DESC, id LIMIT 1',
        [seed.connection.soap_method],
      );
      const source = rows[0] || seed.connection;
      const columns = ['name', 'description', 'target_table', 'row_filter', 'active', 'created_by', ...CONNECTION_COLUMNS];
      const values = [seed.name, seed.description, seed.targetTable, JSON.stringify(seed.rowFilter), false, 'system', ...CONNECTION_COLUMNS.map((c) => source[c])];
      const config = await client.query(
        `INSERT INTO api_configs (${columns.join(', ')})
         VALUES (${columns.map((c, i) => (c === 'row_filter' ? `$${i + 1}::jsonb` : `$${i + 1}`)).join(', ')})
         RETURNING id`,
        values,
      );
      for (const [i, m] of seed.mappings.entries()) {
        await client.query(
          `INSERT INTO api_field_mappings (api_config_id, db_column, source_field, transform, transform_arg, condition, sort_order)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
          [
            config.rows[0].id, m.dbColumn, m.sourceField, m.transform,
            m.transformArg ? JSON.stringify(m.transformArg) : null,
            m.condition ? JSON.stringify(m.condition) : null,
            i + 1,
          ],
        );
      }
      return true;
    });
    if (added) created.push(seed.name);
  }
  return created;
}

module.exports = { SEEDS, seedApiConfigs };
