/**
 * The one place that resolves a UCR row's polymorphic gateway pointer.
 *
 * `ucr_ip_records.match_source_id` has no foreign key — it addresses one of
 * three unrelated processor tables depending on `match_source_type`. Every
 * reader therefore needs the same three-way conditional LEFT JOIN, and the
 * columns it needs are named differently in each table (a settlement date is
 * `process_date` in the Card MPR export, `settlement_date` in the other two).
 *
 * This module owns that normalisation so the join is written once. Callers get
 * generic `msrc_*` aliases; `ucrIpRecordRowToApi` in ../../ucr-mappers.js turns
 * them into `matchedSource` and stays agnostic of which table answered.
 */

/** Aliased gateway columns, normalised across the three processor exports. */
const GATEWAY_SELECT = `
       COALESCE(cm.app_code, cp.approval_code, um.rrn)                    AS msrc_reference,
       COALESCE(cm.pymt_chgamnt, cp.amount, um.transaction_amount)        AS msrc_amount,
       COALESCE(cm.process_date, cp.settlement_date, um.settlement_date)  AS msrc_date,
       COALESCE(cm.pymt_netamnt, cp.amount, um.net_amount)                AS msrc_net_amount,
       -- Pine Labs settles gross: its export carries no fee column, so the fee
       -- is genuinely absent rather than zero. Card MPR splits the deduction
       -- across commission + four GST buckets, any of which may be null.
       COALESCE(
         COALESCE(cm.pymt_comm, 0) + COALESCE(cm.pymt_servtax, 0) + COALESCE(cm.pymt_cgst, 0)
           + COALESCE(cm.pymt_sgst, 0) + COALESCE(cm.pymt_igst, 0) + COALESCE(cm.pymt_utgst, 0),
         um.msf_amount
       )                                                                  AS msrc_fee_amount,
       COALESCE(cm.arn, cp.rrn, um.rrn)                                   AS msrc_rrn,
       COALESCE(cm.transaction_id, cp.transaction_id, um.upi_trxn_id)     AS msrc_transaction_id`;

/** The three-way conditional join. `r` must be the ucr_ip_records alias. */
const GATEWAY_JOIN = `
       LEFT JOIN ucr_card_mpr_records cm       ON r.match_source_type = 'CARD_MPR'      AND cm.id = r.match_source_id
       LEFT JOIN ucr_card_pinelabs_records cp  ON r.match_source_type = 'CARD_PINELABS' AND cp.id = r.match_source_id
       LEFT JOIN ucr_upi_mpr_records um        ON r.match_source_type = 'UPI_MPR'       AND um.id = r.match_source_id`;

/**
 * A UCR row SELECT with its gateway row hydrated.
 *
 * `receipt_date` is re-read via to_char because the report groups by calendar
 * month: letting a TIMESTAMP round-trip through JS Date shifts dates across a
 * month boundary in any timezone behind UTC. Same guard the IP/Diag audit
 * loader uses.
 *
 * @param {string} where  full WHERE clause (or '') — parameter numbering is the caller's
 * @param {string} tail   ORDER BY / LIMIT / OFFSET, appended verbatim
 */
function ucrRecordSelect(where = '', tail = '') {
  return `SELECT r.*,
       to_char(r.receipt_date, 'YYYY-MM-DD') AS receipt_date_ymd,${GATEWAY_SELECT}
  FROM ucr_ip_records r${GATEWAY_JOIN}
 ${where}
 ${tail}`;
}

module.exports = { GATEWAY_SELECT, GATEWAY_JOIN, ucrRecordSelect };
