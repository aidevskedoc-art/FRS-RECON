/**
 * How each target table takes rows from an API sync: its duplicate check and
 * its batch. The record shapes and INSERTs are the file uploads' own
 * (online-upload/*-store.js), so a row stored from the API is the row the file
 * would have stored, and the duplicate check is the one the file upload runs —
 * a receipt already taken from a file is not stored again from the API.
 *
 * An API sync does not get a batch of its own. A unit's rows for one calendar
 * month go into ONE batch per store — "API · IP cheques · Secunderabad ·
 * Sep 2026" — which each day's sync appends to. A batch per sync would be
 * thirty batches a month, per unit, per store, on every Uploaded Files list.
 * The per-day record is the api_sync_runs row.
 */
const db = require('../db');
const { filterNewRows } = require('../online-upload/dedupe');
const { IP_PAYMENT, DIAG_PAYMENT, CHEQUE_COLLECTION, REFUND } = require('../online-upload/mis-identities');
const { splitStoredRows, OVERLAP_KEYS } = require('../online-upload/ucr-overlap');
const { resolveDivision } = require('../reconciliation/matcher');
const ipPayments = require('../online-upload/ip-payment-store');
const diagPayments = require('../online-upload/diag-op-payment-store');
const ucrIp = require('../online-upload/ucr-ip-store');
const chequeCollections = require('../online-upload/cheque-collection-store');
const refunds = require('../online-upload/refund-store');

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const byIdentity = (identity) => (records) => filterNewRows({ ...identity, rows: records });

const insertWith = (store) => (client, batchId, records) =>
  store.insertRecordsChunked(client, records.map((r) => store.recordToRow(batchId, r)));

/**
 * Per target table:
 *   batchTable      where its batches live
 *   label           the store's name inside a batch name; a function of the kind where the table holds several
 *   kindColumn      the batch column that separates kinds sharing the table (IP / OP / DIAG), with
 *   kindOf(record)  reading the same from a mapped record — one batch per unit, month AND kind
 *   dateOf(record)  the date that decides which month's batch a record joins
 *   tracksGenerate  the batch has matched_at; appending clears it, as the batch now holds rows Generate has not seen
 *   prepare         adds what a record takes from the unit, not from the API row
 *   filterNew       -> { newRows, skipped }, the file upload's own duplicate check
 *   insert          the file upload's own INSERT
 *   afterAppend     batch columns that describe the rows it holds
 */
const STORES = {
  ip_payment_records: {
    batchTable: 'ip_payment_upload_batches',
    label: () => 'IP MIS',
    kindColumn: null,
    kindOf: () => null,
    dateOf: (r) => r.receiptDate,
    tracksGenerate: true,
    filterNew: byIdentity(IP_PAYMENT),
    insert: insertWith(ipPayments),
  },

  diag_op_payment_records: {
    batchTable: 'diag_op_upload_batches',
    label: () => 'Diag MIS',
    kindColumn: null,
    kindOf: () => null,
    dateOf: (r) => r.receiptDate,
    tracksGenerate: true,
    filterNew: byIdentity(DIAG_PAYMENT),
    insert: insertWith(diagPayments),
  },

  ucr_ip_records: {
    batchTable: 'ucr_ip_upload_batches',
    label: (kind) => `${kind} Card/UPI`,
    kindColumn: 'mis_source',
    kindOf: (r) => r.misSource,
    dateOf: (r) => r.receiptDate,
    tracksGenerate: true,
    // Compared within its own source, as the uploads do: an IP receipt and a
    // Diagnostics receipt are different series. A row repeated inside one
    // answer stays repeated (real rows — see ucr-overlap.js).
    async filterNew(records) {
      const bySource = new Map();
      for (const r of records) {
        if (!bySource.has(r.misSource)) bySource.set(r.misSource, []);
        bySource.get(r.misSource).push(r);
      }
      const out = { newRows: [], skipped: 0 };
      for (const [source, rows] of bySource) {
        const split = await splitStoredRows(source, rows, OVERLAP_KEYS.IP);
        out.newRows.push(...split.newRows);
        out.skipped += split.skipped;
      }
      return out;
    },
    insert: insertWith(ucrIp),
  },

  cheque_collection_records: {
    batchTable: 'cheque_collection_upload_batches',
    label: (kind) => `${kind} cheques`,
    kindColumn: 'collection_kind',
    kindOf: (r) => r.collectionKind,
    dateOf: (r) => r.receiptDate,
    tracksGenerate: true,
    // A cheque's identity includes its unit (mis-identities.js): the unit synced.
    prepare: (r, { location }) => ({ ...r, __unit: location.name }),
    filterNew: byIdentity(CHEQUE_COLLECTION),
    insert: insertWith(chequeCollections),
  },

  refund_records: {
    batchTable: 'refund_upload_batches',
    label: () => 'Refunds',
    kindColumn: null,
    kindOf: () => null,
    dateOf: (r) => r.chequeDate,
    tracksGenerate: false,
    // The refund document names its unit and division on every row (one
    // workbook holds all four); an API answer is one unit's, so they come from the unit.
    prepare: (r, { location, config }) => ({
      ...r,
      sheetName: `API ${config.name}`.slice(0, 255),
      unitName: location.name,
      division: resolveDivision(location.name),
    }),
    filterNew: byIdentity(REFUND),
    insert: insertWith(refunds),
    async afterAppend(client, batchId, records) {
      const dates = records.map((r) => r.chequeDate).filter(Boolean).sort();
      if (!dates.length) return;
      await client.query(
        `UPDATE refund_upload_batches
            SET document_from = LEAST(document_from, $2::date), document_to = GREATEST(document_to, $3::date)
          WHERE id = $1`,
        [batchId, dates[0], dates[dates.length - 1]],
      );
    },
  },
};

function storeOf(table) {
  return Object.prototype.hasOwnProperty.call(STORES, table) ? STORES[table] : null;
}

/** '2026-09-15' or '2026-09-15T11:55:01.000Z' -> '2026-09'; null when there is no readable date. */
function monthOf(value) {
  const m = /^(\d{4})-(\d{2})/.exec(String(value ?? ''));
  return m ? `${m[1]}-${m[2]}` : null;
}

/** "API · IP cheques · Secunderabad · Sep 2026" */
function batchName(store, unitName, month, kind) {
  const [y, m] = month.split('-');
  return `API · ${store.label(kind)} · ${unitName} · ${MONTH_NAMES[Number(m) - 1]} ${y}`.slice(0, 255);
}

/**
 * Splits records into the monthly batches they belong to: one per kind and
 * month. A record with no readable date joins the month of the day synced.
 * @returns {{ kind: string|null, month: string, rows: object[] }[]}
 */
function groupForBatches(store, records, date) {
  const groups = new Map();
  for (const r of records) {
    const kind = store.kindOf(r) ?? null;
    const month = monthOf(store.dateOf(r)) || monthOf(date);
    const key = `${kind ?? ''}|${month}`;
    if (!groups.has(key)) groups.set(key, { kind, month, rows: [] });
    groups.get(key).rows.push(r);
  }
  return [...groups.values()];
}

/**
 * The unit's API batch for one month (and kind): created empty if this is the
 * month's first sync, otherwise the existing one, locked until the caller's
 * transaction ends. The unique index (sql/schema.sql, "one API batch per unit
 * and month") is what makes two syncs racing for a new month share one batch.
 */
async function monthlyBatch(client, store, { unitName, month, kind, uploadedBy }) {
  const periodMonth = `${month}-01`;
  const cols = ['file_name', 'file_size_bytes', 'row_count', 'uploaded_by', 'unit_name', 'source', 'period_month'];
  const vals = [batchName(store, unitName, month, kind), 0, 0, uploadedBy, unitName, 'API', periodMonth];
  if (store.kindColumn) {
    cols.push(store.kindColumn);
    vals.push(kind);
  }
  const created = await client.query(
    `INSERT INTO ${store.batchTable} (${cols.join(', ')})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
     ON CONFLICT DO NOTHING RETURNING *`,
    vals,
  );
  if (created.rows[0]) return created.rows[0];

  const where = ["source = 'API'", 'unit_name = $1', 'period_month = $2'];
  const params = [unitName, periodMonth];
  if (store.kindColumn) {
    params.push(kind);
    where.push(`${store.kindColumn} = $${params.length}`);
  }
  const found = await client.query(`SELECT * FROM ${store.batchTable} WHERE ${where.join(' AND ')} FOR UPDATE`, params);
  if (!found.rows[0]) throw new Error(`Could not open the API batch for ${unitName}, ${month}`);
  return found.rows[0];
}

/**
 * Stores one API Config's mapped records for one unit-day: the ones not
 * already stored, appended to the month's batch, all in one transaction.
 *
 * @param {{ targetTable:string, records:object[], location:{name:string}, config:{name:string}, date:string, uploadedBy:string|null }} args
 *   `date` is the day synced, 'YYYY-MM-DD'
 * @returns {Promise<{ stored:number, skipped:number, batches:object[] }>}
 *   stored 0 means every record was already there; `batches` are the batch rows appended to
 */
async function storeApiRecords({ targetTable, records, location, config, date, uploadedBy }) {
  const store = storeOf(targetTable);
  if (!store) throw Object.assign(new Error(`No store for target table "${targetTable}"`), { status: 400 });

  const prepared = store.prepare ? records.map((r) => store.prepare(r, { location, config })) : records;
  const { newRows, skipped } = await store.filterNew(prepared);
  if (newRows.length === 0) return { stored: 0, skipped, batches: [] };

  const groups = groupForBatches(store, newRows, date);
  const batches = await db.withTransaction(async (client) => {
    const out = [];
    for (const g of groups) {
      const batch = await monthlyBatch(client, store, { unitName: location.name, month: g.month, kind: g.kind, uploadedBy });
      await store.insert(client, batch.id, g.rows);
      if (store.afterAppend) await store.afterAppend(client, batch.id, g.rows);
      const { rows } = await client.query(
        `UPDATE ${store.batchTable}
            SET row_count = row_count + $2${store.tracksGenerate ? ', matched_at = NULL' : ''}
          WHERE id = $1 RETURNING *`,
        [batch.id, g.rows.length],
      );
      out.push(rows[0]);
    }
    return out;
  });
  return { stored: newRows.length, skipped, batches };
}

module.exports = { STORES, storeOf, storeApiRecords, groupForBatches, batchName, monthOf };
