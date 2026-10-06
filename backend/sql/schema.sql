-- FRS insurance policy extraction schema. Idempotent — safe to run repeatedly.

CREATE TABLE IF NOT EXISTS documents (
  id                        SERIAL PRIMARY KEY,
  file_name                 VARCHAR(255) NOT NULL,
  file_size_bytes           INTEGER NOT NULL,
  page_count                INTEGER,
  uploaded_at                TIMESTAMP NOT NULL DEFAULT now(),
  status                     VARCHAR(32) NOT NULL DEFAULT 'Uploaded',
  file_path                  VARCHAR(512) NOT NULL,
  error_message               TEXT,
  pages_analyzed               INTEGER,
  fields_extracted             INTEGER,
  fields_total                 INTEGER,
  overall_confidence           VARCHAR(16),
  overall_confidence_score     INTEGER,
  processing_time_ms           INTEGER,
  extracted_at                 TIMESTAMP
);

CREATE TABLE IF NOT EXISTS policies (
  id                        SERIAL PRIMARY KEY,
  document_id               INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  policyholder_name          VARCHAR(255),
  policyholder_address       TEXT,
  customer_id                VARCHAR(64),
  insurance_company          VARCHAR(255),
  insurance_company_address  TEXT,
  policy_number               VARCHAR(128),
  policy_start_date           DATE,
  policy_end_date             DATE,
  policy_tenure_months        INTEGER,
  policy_receipt_date         DATE,
  receipt_number               VARCHAR(64),
  plan_chosen                  VARCHAR(255),
  policy_type                  VARCHAR(64),
  new_or_renewal                VARCHAR(16),
  sum_insured                   NUMERIC(14,2),
  total_basic_premium           NUMERIC(14,2),
  family_floater_discount       NUMERIC(14,2),
  premium                       NUMERIC(14,2),
  gst                           NUMERIC(14,2),
  total_premium                 NUMERIC(14,2),
  nominee_name                   VARCHAR(255),
  nominee_relationship           VARCHAR(64),
  tpa_name                       VARCHAR(255),
  tpa_id                         VARCHAR(64),
  previous_policy_number         VARCHAR(128),
  previous_insurer               VARCHAR(255),
  previous_end_date              DATE,
  created_at                     TIMESTAMP NOT NULL DEFAULT now(),
  updated_at                     TIMESTAMP NOT NULL DEFAULT now(),
  excel_generated_at             TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS policies_document_id_key ON policies(document_id);

CREATE TABLE IF NOT EXISTS insured_members (
  id                           SERIAL PRIMARY KEY,
  policy_id                    INTEGER NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  name                          VARCHAR(255) NOT NULL,
  relation_with_policy_holder   VARCHAR(32),
  age                            INTEGER,
  gender                         VARCHAR(16),
  occupation                     VARCHAR(255),
  base_premium                   NUMERIC(14,2),
  policy_type_self_parents       VARCHAR(32),
  sort_order                     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS insured_members_policy_id_idx ON insured_members(policy_id);

CREATE TABLE IF NOT EXISTS extraction_fields (
  id                SERIAL PRIMARY KEY,
  document_id        INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  path                VARCHAR(128) NOT NULL,
  label                VARCHAR(255) NOT NULL,
  value_text           TEXT,
  confidence           VARCHAR(16) NOT NULL,
  confidence_score     INTEGER NOT NULL,
  source_page          INTEGER,
  verified             BOOLEAN NOT NULL DEFAULT false
);

CREATE UNIQUE INDEX IF NOT EXISTS extraction_fields_document_path_key ON extraction_fields(document_id, path);
CREATE INDEX IF NOT EXISTS extraction_fields_document_id_idx ON extraction_fields(document_id);

-- ---------------------------------------------------------------------------
-- Additive migrations. Kept as ALTER ... IF NOT EXISTS so this file stays
-- runnable against both a fresh database and one created by an earlier
-- version, per the same convention as the CREATE TABLE statements above.
-- ---------------------------------------------------------------------------

-- Real schedules carry the nominee per insured member, not once per policy.
ALTER TABLE insured_members ADD COLUMN IF NOT EXISTS nominee_name        VARCHAR(255);
ALTER TABLE insured_members ADD COLUMN IF NOT EXISTS nominee_relation    VARCHAR(64);
ALTER TABLE insured_members ADD COLUMN IF NOT EXISTS date_of_birth       DATE;
ALTER TABLE insured_members ADD COLUMN IF NOT EXISTS inception_date      DATE;

-- Tenure is reported in days in the client's output (09-Jun-26 to 08-Jun-27 = 365).
ALTER TABLE policies ADD COLUMN IF NOT EXISTS policy_tenure_days          INTEGER;
-- The schedule's printed "Receipt Date:" differs from the receipt date the
-- client's output uses (which mirrors the policy start date); both are kept.
ALTER TABLE policies ADD COLUMN IF NOT EXISTS printed_receipt_date        DATE;
ALTER TABLE policies ADD COLUMN IF NOT EXISTS insurance_company_legal_name VARCHAR(255);
ALTER TABLE policies ADD COLUMN IF NOT EXISTS source_format               VARCHAR(64);

-- SHA-256 of the uploaded file's bytes, checked at upload time so the same
-- PDF can't be uploaded twice under a different file name.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS file_hash VARCHAR(64);
CREATE INDEX IF NOT EXISTS documents_file_hash_idx ON documents(file_hash);

-- Receipt numbers run to 20 digits — must stay text so no float rounding
-- can truncate them (the client's own spreadsheet lost the last 5 digits).
ALTER TABLE policies ALTER COLUMN receipt_number TYPE VARCHAR(64);

-- What the AI pass actually did on the last extraction, so the Extraction
-- Workspace can show its contribution instead of leaving a blank screen
-- unexplained. JSONB rather than columns because the shape is diagnostic
-- output, not queried domain data — see ai-extraction.js for the fields.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS ai_diagnostics JSONB;

-- ---------------------------------------------------------------------------
-- Upload Online: MIS data (IP / Diag payments) and bank statements.
-- Both MIS formats' source headers are shifted from their actual data (a
-- known export quirk); the parser corrects this before rows land here, so
-- every column below already holds the semantically-correct value.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS online_upload_batches (
  id                SERIAL PRIMARY KEY,
  upload_type       VARCHAR(16) NOT NULL,   -- 'IP_PAYMENT' | 'DIAG_PAYMENT'
  source_format     VARCHAR(16) NOT NULL,   -- 'FORMAT_1' | 'FORMAT_2'
  file_name         VARCHAR(255) NOT NULL,
  file_size_bytes   INTEGER NOT NULL,
  row_count         INTEGER NOT NULL DEFAULT 0,
  uploaded_by       VARCHAR(255),
  uploaded_at       TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS online_upload_batches_upload_type_idx ON online_upload_batches(upload_type);

CREATE TABLE IF NOT EXISTS online_payment_records (
  id                  SERIAL PRIMARY KEY,
  batch_id            INTEGER NOT NULL REFERENCES online_upload_batches(id) ON DELETE CASCADE,
  upload_type         VARCHAR(16) NOT NULL,
  -- Positional fields sourced from an export we don't control the content
  -- of (verified against only 1-2 sample rows per format) are kept generously
  -- wide, same rationale as policies.receipt_number's widening below — a
  -- narrower guess already truncated real diag-payment uploads once.
  receipt_number      VARCHAR(255),
  receipt_date        TIMESTAMP,
  yhno                VARCHAR(255),
  ip_no               VARCHAR(255),
  diag_no             VARCHAR(255),
  patient_name        VARCHAR(255),
  transaction_ref_1   VARCHAR(255),
  transaction_ref_2   VARCHAR(255),
  transaction_ref_3   VARCHAR(255),  -- Format 2 only
  payment_mode        VARCHAR(255),  -- Format 1 only
  pay_mode             VARCHAR(255), -- Format 2 only
  pay_type            VARCHAR(255),
  remarks              VARCHAR(255), -- Format 1 only
  payment_remarks      VARCHAR(255), -- Format 1 only
  pat_type             VARCHAR(255),
  bill_amount           NUMERIC(14,2),
  cash_amount            NUMERIC(14,2),
  card_amount             NUMERIC(14,2),
  cheque_amount            NUMERIC(14,2),
  online_upi_amount        NUMERIC(14,2),
  discount_amount           NUMERIC(14,2), -- Format 2 only
  diff_amount                NUMERIC(14,2), -- Format 2 only
  user_id                     VARCHAR(255),
  user_name                    VARCHAR(255),
  created_at                    TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS online_payment_records_batch_id_idx ON online_payment_records(batch_id);
CREATE INDEX IF NOT EXISTS online_payment_records_upload_type_idx ON online_payment_records(upload_type);

CREATE TABLE IF NOT EXISTS bank_statement_uploads (
  id                SERIAL PRIMARY KEY,
  bank_name         VARCHAR(255),
  account_no        VARCHAR(64),
  account_branch    VARCHAR(255),
  statement_from    DATE,
  statement_to      DATE,
  file_name         VARCHAR(255) NOT NULL,
  file_size_bytes   INTEGER NOT NULL,
  row_count         INTEGER NOT NULL DEFAULT 0,
  uploaded_by       VARCHAR(255),
  uploaded_at       TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bank_statement_records (
  id                SERIAL PRIMARY KEY,
  batch_id          INTEGER NOT NULL REFERENCES bank_statement_uploads(id) ON DELETE CASCADE,
  txn_date          DATE,
  narration         TEXT,
  chq_ref_no        VARCHAR(64),
  value_date        DATE,
  withdrawal_amt    NUMERIC(14,2),
  deposit_amt       NUMERIC(14,2),
  closing_balance   NUMERIC(14,2)
);

CREATE INDEX IF NOT EXISTS bank_statement_records_batch_id_idx ON bank_statement_records(batch_id);

-- The initial VARCHAR(32)/(64) guesses above truncated real diag-payment
-- uploads (columns we'd only verified against 1-2 blank-heavy sample rows).
-- Widened uniformly rather than chasing one column at a time.
ALTER TABLE online_payment_records ALTER COLUMN receipt_number TYPE VARCHAR(255);
ALTER TABLE online_payment_records ALTER COLUMN yhno TYPE VARCHAR(255);
ALTER TABLE online_payment_records ALTER COLUMN ip_no TYPE VARCHAR(255);
ALTER TABLE online_payment_records ALTER COLUMN diag_no TYPE VARCHAR(255);
ALTER TABLE online_payment_records ALTER COLUMN transaction_ref_1 TYPE VARCHAR(255);
ALTER TABLE online_payment_records ALTER COLUMN transaction_ref_2 TYPE VARCHAR(255);
ALTER TABLE online_payment_records ALTER COLUMN transaction_ref_3 TYPE VARCHAR(255);
ALTER TABLE online_payment_records ALTER COLUMN payment_mode TYPE VARCHAR(255);
ALTER TABLE online_payment_records ALTER COLUMN pay_mode TYPE VARCHAR(255);
ALTER TABLE online_payment_records ALTER COLUMN pay_type TYPE VARCHAR(255);
ALTER TABLE online_payment_records ALTER COLUMN pat_type TYPE VARCHAR(255);
ALTER TABLE online_payment_records ALTER COLUMN user_id TYPE VARCHAR(255);

-- ---------------------------------------------------------------------------
-- IP Payments (dedicated). Replaces the IP_PAYMENT rows of online_upload_batches
-- / online_payment_records for new uploads — this table only ever holds Format 1
-- data, so it carries just the 19 real fields with no Format-2-only columns.
-- Historical IP_PAYMENT rows already in online_payment_records are left as-is.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ip_payment_upload_batches (
  id                SERIAL PRIMARY KEY,
  file_name         VARCHAR(255) NOT NULL,
  file_size_bytes   INTEGER NOT NULL,
  row_count         INTEGER NOT NULL DEFAULT 0,
  uploaded_by       VARCHAR(255),
  uploaded_at       TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ip_payment_records (
  id                  SERIAL PRIMARY KEY,
  batch_id            INTEGER NOT NULL REFERENCES ip_payment_upload_batches(id) ON DELETE CASCADE,
  receipt_number      VARCHAR(255),
  receipt_date        TIMESTAMP,
  yhno                VARCHAR(255),
  ip_no               VARCHAR(255),
  patient_name        VARCHAR(255),
  transaction_id_1    VARCHAR(255),
  transaction_id_2    VARCHAR(255),
  payment_mode        VARCHAR(255),
  pay_type            VARCHAR(255),
  remarks             VARCHAR(255),
  payment_remarks     VARCHAR(255),
  pat_type            VARCHAR(255),
  bill_amount         NUMERIC(14,2),
  cash_amount         NUMERIC(14,2),
  card_amount         NUMERIC(14,2),
  cheque_amount       NUMERIC(14,2),
  online_amount       NUMERIC(14,2),
  user_id             VARCHAR(255),
  user_name           VARCHAR(255),
  created_at          TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ip_payment_records_batch_id_idx ON ip_payment_records(batch_id);

-- Merge of transaction_id_1/transaction_id_2, populated at upload time.
ALTER TABLE ip_payment_records ADD COLUMN IF NOT EXISTS trans_id VARCHAR(255);

-- ---------------------------------------------------------------------------
-- Diag OP Payments (dedicated). Replaces the DIAG_PAYMENT rows of
-- online_upload_batches / online_payment_records for new uploads — same
-- rationale as ip_payment_records above. Historical DIAG_PAYMENT rows already
-- in online_payment_records are left as-is.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS diag_op_upload_batches (
  id                SERIAL PRIMARY KEY,
  file_name         VARCHAR(255) NOT NULL,
  file_size_bytes   INTEGER NOT NULL,
  row_count         INTEGER NOT NULL DEFAULT 0,
  uploaded_by       VARCHAR(255),
  uploaded_at       TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS diag_op_payment_records (
  id                  SERIAL PRIMARY KEY,
  batch_id            INTEGER NOT NULL REFERENCES diag_op_upload_batches(id) ON DELETE CASCADE,
  receipt_number      VARCHAR(255),
  receipt_date        TIMESTAMP,
  yhno                VARCHAR(255),
  diag_no             VARCHAR(255),
  patient_name        VARCHAR(255),
  transaction_id_1    VARCHAR(255),
  transaction_id_2    VARCHAR(255),
  transaction_id_3    VARCHAR(255),
  pay_type            VARCHAR(255),
  pay_mode            VARCHAR(255),
  pat_type            VARCHAR(255),
  bill_amount         NUMERIC(14,2),
  cash_amount         NUMERIC(14,2),
  card_amount         NUMERIC(14,2),
  cheque_amount       NUMERIC(14,2),
  online_amount       NUMERIC(14,2),
  discount_amount     NUMERIC(14,2),
  diff_amount         NUMERIC(14,2),
  user_id             VARCHAR(255),
  user_name           VARCHAR(255),
  created_at          TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS diag_op_payment_records_batch_id_idx ON diag_op_payment_records(batch_id);

-- ---------------------------------------------------------------------------
-- Master Data: Division & Bank A/C.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS master_division_bank_accounts (
  id               SERIAL PRIMARY KEY,
  division_name    VARCHAR(64) NOT NULL CHECK (division_name IN ('Hitech City', 'Somajiguda', 'Secunderabad', 'Malakpet')),
  account_number   VARCHAR(64) NOT NULL,
  bank_name        VARCHAR(255) NOT NULL,
  active           BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMP NOT NULL DEFAULT now(),
  updated_at       TIMESTAMP NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS master_division_bank_accounts_account_number_key ON master_division_bank_accounts(account_number);
CREATE INDEX IF NOT EXISTS master_division_bank_accounts_division_name_idx ON master_division_bank_accounts(division_name);

INSERT INTO master_division_bank_accounts (division_name, account_number, bank_name) VALUES
  ('Hitech City',   '99966778889999', 'HDFC BANK LTD'),
  ('Hitech City',   '50200029017999', 'HDFC BANK LTD'),
  ('Malakpet',      '59291122233344', 'HDFC BANK LTD'),
  ('Malakpet',      '02182320001038', 'HDFC BANK LTD'),
  ('Secunderabad',  '05122320000771', 'HDFC BANK LTD'),
  ('Secunderabad',  '59219911199911', 'HDFC BANK LTD'),
  ('Somajiguda',    '99995542998888', 'HDFC BANK LTD'),
  ('Somajiguda',    '99995542997777', 'HDFC BANK LTD')
ON CONFLICT (account_number) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Unit Name: hospital/division title captured from row 0 of the uploaded MIS
-- Excel (e.g. "YASHODA HEALTHCARE SERVICES LIMITED, HITECH CITY"). One value
-- per upload, not per record, so it lives on the batch tables.
-- ---------------------------------------------------------------------------

ALTER TABLE ip_payment_upload_batches ADD COLUMN IF NOT EXISTS unit_name VARCHAR(255);
ALTER TABLE diag_op_upload_batches ADD COLUMN IF NOT EXISTS unit_name VARCHAR(255);


-- ---------------------------------------------------------------------------
-- Matching rules (condition-only engine). A rule is name + action +
-- condition_groups. condition_groups is CNF: a JSON array of OR-groups, each
-- an array of leaves; a leaf is { kind:'LITERAL', field, operator, value,
-- negate? } or { kind:'FIELD_PAIR', sourceField, destinationField,
-- pairOperator, pairTolerance?, negate? }. A rule matches a (payment, bank)
-- pair when every OR-group has >=1 satisfied leaf; the first active rule (by
-- sort_order) that matches some bank row wins and its action sets the
-- verdict. There is no config layer — see reconciliation/rules.js. IP and
-- Diag rules live in separate tables, one per record table. Each table's rule
-- set runs over ALL rows of that type; "online" vs "UPI" is decided inside a
-- rule by a payment-mode condition (a rule keyed on Chq/Ref No handles
-- NEFT/IMPS/RTGS, one keyed on Narration handles UPI). upi_payment_matching_rules
-- is retired scaffolding — kept so an old DB does not error, not read by the
-- engine.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ip_payment_matching_rules (
  id                SERIAL PRIMARY KEY,
  name              VARCHAR(255) NOT NULL,
  action            VARCHAR(64) NOT NULL,
  active            BOOLEAN NOT NULL DEFAULT true,
  sort_order        INTEGER,
  condition_groups  JSONB,
  created_at        TIMESTAMP NOT NULL DEFAULT now(),
  updated_at        TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS diag_payment_matching_rules (
  id                SERIAL PRIMARY KEY,
  name              VARCHAR(255) NOT NULL,
  action            VARCHAR(64) NOT NULL,
  active            BOOLEAN NOT NULL DEFAULT true,
  sort_order        INTEGER,
  condition_groups  JSONB,
  created_at        TIMESTAMP NOT NULL DEFAULT now(),
  updated_at        TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS upi_payment_matching_rules (
  id                SERIAL PRIMARY KEY,
  name              VARCHAR(255) NOT NULL,
  action            VARCHAR(64) NOT NULL,
  active            BOOLEAN NOT NULL DEFAULT true,
  sort_order        INTEGER,
  condition_groups  JSONB,
  created_at        TIMESTAMP NOT NULL DEFAULT now(),
  updated_at        TIMESTAMP NOT NULL DEFAULT now()
);

-- Cheque collection reconciles in two stages against two different documents:
-- CNF rules match a cheque to a BANK STATEMENT line, and a CONTRA_ENTRY rule
-- then accounts for what is left against the REFUND DOCUMENT. Both live here,
-- ordered by sort_order like every other rule set.
--
-- Declared BEFORE the migration block below, not after: that block ALTERs
-- every table it is given with no IF EXISTS guard, and this whole file runs as
-- a single statement, so a table missing at that point takes the server down
-- with it.
CREATE TABLE IF NOT EXISTS cheque_matching_rules (
  id                SERIAL PRIMARY KEY,
  name              VARCHAR(255) NOT NULL,
  action            VARCHAR(64) NOT NULL,
  active            BOOLEAN NOT NULL DEFAULT true,
  sort_order        INTEGER,
  condition_groups  JSONB,
  created_at        TIMESTAMP NOT NULL DEFAULT now(),
  updated_at        TIMESTAMP NOT NULL DEFAULT now()
);

-- Migrate an older rule table (config-layer era) to the shape above: widen
-- `action`, add the new columns, fold any legacy `conditions` JSON into
-- `condition_groups` (each old AND entry becomes its own single-leaf
-- OR-group), then drop every abandoned column. Guarded so this file stays
-- idempotent against a fresh DB and every prior version.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ip_payment_matching_rules', 'diag_payment_matching_rules', 'upi_payment_matching_rules', 'cheque_matching_rules'] LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN action TYPE VARCHAR(64)', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS sort_order INTEGER', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS condition_groups JSONB', t);
    EXECUTE format('UPDATE %I SET sort_order = id WHERE sort_order IS NULL', t);

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = t AND column_name = 'conditions') THEN
      EXECUTE format(
        'UPDATE %I SET condition_groups = (
           SELECT jsonb_agg(jsonb_build_array(e)) FROM jsonb_array_elements(conditions::jsonb) e
         ) WHERE conditions IS NOT NULL AND conditions <> '''' AND condition_groups IS NULL', t);
    END IF;

    EXECUTE format(
      'ALTER TABLE %I
         DROP COLUMN IF EXISTS conditions,
         DROP COLUMN IF EXISTS field,
         DROP COLUMN IF EXISTS operator,
         DROP COLUMN IF EXISTS value,
         DROP COLUMN IF EXISTS condition_kind,
         DROP COLUMN IF EXISTS source_field,
         DROP COLUMN IF EXISTS destination_field,
         DROP COLUMN IF EXISTS pair_operator,
         DROP COLUMN IF EXISTS pair_tolerance,
         DROP COLUMN IF EXISTS is_system,
         DROP COLUMN IF EXISTS amount_tolerance,
         DROP COLUMN IF EXISTS reference_fields,
         DROP COLUMN IF EXISTS suffix_grouping,
         DROP COLUMN IF EXISTS division_scoping,
         DROP COLUMN IF EXISTS bank_fields,
         DROP COLUMN IF EXISTS amount_fields,
         DROP COLUMN IF EXISTS bank_amount_side,
         DROP COLUMN IF EXISTS tie_break', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Retire the first attempt at "Transaction Amount Match on Same Unit".
--
-- It was seeded as an ordinary CNF rule whose conditions grouped payments by
-- their reference with the trailing letter STRIPPED, so ACCOUNT001A and
-- ACCOUNT001B fell into one group. The requirement is the opposite: rows
-- group only when their ending identifier is the SAME, and A must never merge
-- with B (§9 / AC-04). The rule is therefore deleted rather than adjusted -
-- its logic is inverted, not incomplete.
--
-- Matched on BOTH name and action so only the rule this file created is
-- removed; a hand-written rule that merely shares the name is left alone.
-- Superseded by the UNIT_AGGREGATION rule kind below.
-- ---------------------------------------------------------------------------
DELETE FROM ip_payment_matching_rules
 WHERE name = 'Transaction Amount Match on Same Unit'
   AND action = 'FORCE_MATCHED_TXN_AMOUNT_SAME_UNIT';

DELETE FROM diag_payment_matching_rules
 WHERE name = 'Transaction Amount Match on Same Unit'
   AND action = 'FORCE_MATCHED_TXN_AMOUNT_SAME_UNIT';

-- ...and clear the numbers it wrote. The match_group_* columns now hold the
-- UNIT the row was aggregated into, but they still contain values computed by
-- the deleted rule under its inverted semantics. Left in place they would be
-- displayed under the new "Unit / Unit Total / Unit Size" headings — old wrong
-- data wearing new labels, which is worse than showing nothing. Cleared here so
-- the columns read blank until the next Generate recomputes them honestly.
-- Only the aggregation columns are touched; match_status and the rest of the
-- verdict are left exactly as they were.
UPDATE ip_payment_records
   SET match_group_base_ref = NULL, match_group_member_count = NULL,
       match_group_total = NULL, match_group_difference = NULL
 WHERE match_group_base_ref IS NOT NULL
    OR match_group_member_count IS NOT NULL
    OR match_group_total IS NOT NULL;

UPDATE diag_op_payment_records
   SET match_group_base_ref = NULL, match_group_member_count = NULL,
       match_group_total = NULL, match_group_difference = NULL
 WHERE match_group_base_ref IS NOT NULL
    OR match_group_member_count IS NOT NULL
    OR match_group_total IS NOT NULL;

-- ---------------------------------------------------------------------------
-- "Transaction Amount Match on Same Unit" lives in the SAME tables as every
-- other rule, so it is managed from the one Master Rules screen rather than a
-- place of its own.
--
-- Two rule shapes now share a table, told apart by `kind`:
--
--   CNF               condition_groups holds an AND-list of OR-groups,
--                     evaluated per (payment row, bank row) pair. Every
--                     pre-existing rule is this, which is why `kind` defaults
--                     to 'CNF' — an untouched row keeps behaving exactly as
--                     before.
--   UNIT_AGGREGATION  unit_config holds the aggregation settings. It has no
--                     conditions: it groups many rows and compares one total,
--                     which no per-pair condition can express.
--
-- The CHECK enforces that each kind carries its own payload and not the other,
-- so a half-filled row cannot reach the engine. Constraints are dropped and
-- re-added rather than guarded, so re-running this file converges from any
-- state; both are satisfied by every existing row, which matters because
-- schema.sql is applied as a SINGLE statement and one violated constraint
-- would abort the whole thing.
-- ---------------------------------------------------------------------------
DO $kind$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ip_payment_matching_rules', 'diag_payment_matching_rules', 'upi_payment_matching_rules', 'cheque_matching_rules'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS kind VARCHAR(32) NOT NULL DEFAULT ''CNF''', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS unit_config JSONB', t);
    -- Must precede the _payload_chk below, which references it in the same
    -- loop iteration.
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS contra_config JSONB', t);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN condition_groups DROP NOT NULL', t);

    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', t, t || '_kind_chk');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (kind IN (''CNF'', ''UNIT_AGGREGATION'', ''CONTRA_ENTRY''))', t, t || '_kind_chk');

    -- Deliberately one-sided: it constrains UNIT_AGGREGATION rows only.
    --
    -- The symmetric version (CNF must have condition_groups) looks tidier and
    -- breaks the application: rules predating the condition_groups column can
    -- legitimately hold NULL there — the config-era migration above only fills
    -- it when a legacy `conditions` value existed — so the constraint failed
    -- on real rows. schema.sql runs as ONE statement, so that single failure
    -- aborted the entire file and the server could not boot. A NULL-condition
    -- CNF rule is already handled: isIndexable rejects it and it never runs.
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', t, t || '_payload_chk');
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I
         CHECK ((kind <> ''UNIT_AGGREGATION'' OR unit_config   IS NOT NULL)
            AND (kind <> ''CONTRA_ENTRY''     OR contra_config IS NOT NULL))',
      t, t || '_payload_chk');
  END LOOP;
END $kind$;

-- Carry across anything already configured in the standalone table this
-- replaces, so an edit made there is not silently lost. Matched on name, so a
-- re-run cannot duplicate the rule.
DO $migrate$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'unit_matching_rules') THEN
    INSERT INTO ip_payment_matching_rules (name, action, active, kind, condition_groups, unit_config, sort_order)
    SELECT u.name, 'UNIT_AGGREGATION', u.active, 'UNIT_AGGREGATION', NULL,
           jsonb_build_object(
             'direction', u.direction, 'unitKeyMode', u.unit_key_mode, 'scope', u.scope,
             'tolerance', u.tolerance, 'useNarration', u.use_narration,
             'paymentRefField', COALESCE(u.payment_ref_field, 'AUTO'),
             'bankRefField', COALESCE(u.bank_ref_field, 'chqRefNo')),
           (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM ip_payment_matching_rules)
      FROM unit_matching_rules u
     WHERE u.payment_type = 'IP_PAYMENT'
       AND NOT EXISTS (SELECT 1 FROM ip_payment_matching_rules r WHERE r.name = u.name AND r.kind = 'UNIT_AGGREGATION');

    INSERT INTO diag_payment_matching_rules (name, action, active, kind, condition_groups, unit_config, sort_order)
    SELECT u.name, 'UNIT_AGGREGATION', u.active, 'UNIT_AGGREGATION', NULL,
           jsonb_build_object(
             'direction', u.direction, 'unitKeyMode', u.unit_key_mode, 'scope', u.scope,
             'tolerance', u.tolerance, 'useNarration', u.use_narration,
             'paymentRefField', COALESCE(u.payment_ref_field, 'AUTO'),
             'bankRefField', COALESCE(u.bank_ref_field, 'chqRefNo')),
           (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM diag_payment_matching_rules)
      FROM unit_matching_rules u
     WHERE u.payment_type = 'DIAG_PAYMENT'
       AND NOT EXISTS (SELECT 1 FROM diag_payment_matching_rules r WHERE r.name = u.name AND r.kind = 'UNIT_AGGREGATION');

    DROP TABLE unit_matching_rules;
  END IF;
END $migrate$;

-- Seed for a database that never had the standalone table. EXACT and DIVISION
-- as specified: identical identifiers group, different ones never merge, and a
-- unit can never span two units.
INSERT INTO ip_payment_matching_rules (name, action, active, kind, condition_groups, unit_config, sort_order)
SELECT 'Transaction Amount Match on Same Unit', 'UNIT_AGGREGATION', true, 'UNIT_AGGREGATION', NULL,
       '{"direction":"MIS_TO_BANK","unitKeyMode":"EXACT","scope":"DIVISION","tolerance":0,"useNarration":true,"paymentRefField":"AUTO","bankRefField":"chqRefNo"}'::jsonb,
       (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM ip_payment_matching_rules)
WHERE NOT EXISTS (SELECT 1 FROM ip_payment_matching_rules WHERE kind = 'UNIT_AGGREGATION');

INSERT INTO diag_payment_matching_rules (name, action, active, kind, condition_groups, unit_config, sort_order)
SELECT 'Transaction Amount Match on Same Unit', 'UNIT_AGGREGATION', true, 'UNIT_AGGREGATION', NULL,
       '{"direction":"MIS_TO_BANK","unitKeyMode":"EXACT","scope":"DIVISION","tolerance":0,"useNarration":true,"paymentRefField":"AUTO","bankRefField":"chqRefNo"}'::jsonb,
       (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM diag_payment_matching_rules)
WHERE NOT EXISTS (SELECT 1 FROM diag_payment_matching_rules WHERE kind = 'UNIT_AGGREGATION');

INSERT INTO upi_payment_matching_rules (name, action, active, kind, condition_groups, unit_config, sort_order)
SELECT 'Transaction Amount Match on Same Unit', 'UNIT_AGGREGATION', true, 'UNIT_AGGREGATION', NULL,
       '{"direction":"MIS_TO_BANK","unitKeyMode":"EXACT","scope":"DIVISION","tolerance":0,"useNarration":true,"paymentRefField":"AUTO","bankRefField":"chqRefNo"}'::jsonb,
       (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM upi_payment_matching_rules)
WHERE NOT EXISTS (SELECT 1 FROM upi_payment_matching_rules WHERE kind = 'UNIT_AGGREGATION');

-- ---------------------------------------------------------------------------
-- "Transaction Amount Match on Other Units" — the same aggregation with the
-- unit boundary lifted, so transactions sharing an identifier are summed even
-- when they belong to DIFFERENT divisions.
--
-- Seeded AFTER the same-unit rule and therefore lower priority, which is what
-- keeps the two from competing: the stricter rule claims what it can first,
-- and this one only ever sees what is still unmatched. A settlement that sits
-- entirely inside one division is therefore always reported as a same-unit
-- match, never as a cross-unit one.
--
-- Seeded INACTIVE. Summing across units is a real reconciliation decision -
-- it can pair a Somajiguda receipt with a Hitech City credit - so it is
-- switched on deliberately from Manage Rules rather than silently changing
-- everyone's numbers on upgrade.
-- ---------------------------------------------------------------------------
INSERT INTO ip_payment_matching_rules (name, action, active, kind, condition_groups, unit_config, sort_order)
SELECT 'Transaction Amount Match on Other Units', 'UNIT_AGGREGATION', false, 'UNIT_AGGREGATION', NULL,
       '{"direction":"MIS_TO_BANK","unitKeyMode":"EXACT","scope":"NONE","tolerance":0,"useNarration":true,"paymentRefField":"AUTO","bankRefField":"chqRefNo"}'::jsonb,
       (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM ip_payment_matching_rules)
WHERE NOT EXISTS (SELECT 1 FROM ip_payment_matching_rules WHERE name = 'Transaction Amount Match on Other Units');

INSERT INTO diag_payment_matching_rules (name, action, active, kind, condition_groups, unit_config, sort_order)
SELECT 'Transaction Amount Match on Other Units', 'UNIT_AGGREGATION', false, 'UNIT_AGGREGATION', NULL,
       '{"direction":"MIS_TO_BANK","unitKeyMode":"EXACT","scope":"NONE","tolerance":0,"useNarration":true,"paymentRefField":"AUTO","bankRefField":"chqRefNo"}'::jsonb,
       (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM diag_payment_matching_rules)
WHERE NOT EXISTS (SELECT 1 FROM diag_payment_matching_rules WHERE name = 'Transaction Amount Match on Other Units');

INSERT INTO upi_payment_matching_rules (name, action, active, kind, condition_groups, unit_config, sort_order)
SELECT 'Transaction Amount Match on Other Units', 'UNIT_AGGREGATION', false, 'UNIT_AGGREGATION', NULL,
       '{"direction":"MIS_TO_BANK","unitKeyMode":"EXACT","scope":"NONE","tolerance":0,"useNarration":true,"paymentRefField":"AUTO","bankRefField":"chqRefNo"}'::jsonb,
       (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM upi_payment_matching_rules)
WHERE NOT EXISTS (SELECT 1 FROM upi_payment_matching_rules WHERE name = 'Transaction Amount Match on Other Units');

-- ---------------------------------------------------------------------------
-- Persisted match results: POST .../generate runs the engine once and writes
-- the verdict onto every record it covers. NULL match_status = never
-- generated. match_applied_rule is the winning rule's name; match_reason is
-- 'Matched by rule "<name>"' / 'No matching rule'. match_amount_field is
-- retained but always NULL now (no amount-field concept).
-- ---------------------------------------------------------------------------

ALTER TABLE ip_payment_upload_batches ADD COLUMN IF NOT EXISTS matched_at TIMESTAMP;
ALTER TABLE diag_op_upload_batches ADD COLUMN IF NOT EXISTS matched_at TIMESTAMP;

ALTER TABLE ip_payment_records ADD COLUMN IF NOT EXISTS match_status VARCHAR(20);
ALTER TABLE ip_payment_records ADD COLUMN IF NOT EXISTS match_applied_rule VARCHAR(255);
ALTER TABLE ip_payment_records ADD COLUMN IF NOT EXISTS match_amount_field VARCHAR(64);
ALTER TABLE ip_payment_records ADD COLUMN IF NOT EXISTS match_bank_record_id INTEGER REFERENCES bank_statement_records(id) ON DELETE SET NULL;
ALTER TABLE ip_payment_records ADD COLUMN IF NOT EXISTS match_reason TEXT;
CREATE INDEX IF NOT EXISTS ip_payment_records_match_status_idx ON ip_payment_records(match_status);
-- Without this, deleting a bank statement is O(bank rows x payment rows): the
-- ON DELETE SET NULL back-reference below forces a full scan of this table for
-- every one of the ~9k cascade-deleted bank_statement_records rows, so a
-- delete of a large statement hangs for minutes.
CREATE INDEX IF NOT EXISTS ip_payment_records_match_bank_record_id_idx ON ip_payment_records(match_bank_record_id);

ALTER TABLE diag_op_payment_records ADD COLUMN IF NOT EXISTS match_status VARCHAR(20);
ALTER TABLE diag_op_payment_records ADD COLUMN IF NOT EXISTS match_applied_rule VARCHAR(255);
ALTER TABLE diag_op_payment_records ADD COLUMN IF NOT EXISTS match_amount_field VARCHAR(64);
ALTER TABLE diag_op_payment_records ADD COLUMN IF NOT EXISTS match_bank_record_id INTEGER REFERENCES bank_statement_records(id) ON DELETE SET NULL;
ALTER TABLE diag_op_payment_records ADD COLUMN IF NOT EXISTS match_reason TEXT;
CREATE INDEX IF NOT EXISTS diag_op_payment_records_match_status_idx ON diag_op_payment_records(match_status);
CREATE INDEX IF NOT EXISTS diag_op_payment_records_match_bank_record_id_idx ON diag_op_payment_records(match_bank_record_id);

-- Suffix-family facts behind a verdict, persisted by POST .../generate so the
-- batch-detail table can show WHY a 50,000 payment matched a 2,81,897 credit
-- (see applySuffixFamilyTotals in reconciliation/matcher.js). Always written,
-- not only for group rules: an unsplit payment is a family of one, so it gets
-- member_count = 1 and total = its own bill amount.
--
-- match_group_total holds the summed BILL amount specifically. A rule may be
-- edited to compare a different column (Cash / Card / Cheque / Online-UPI) —
-- the verdict follows the rule, while this column stays the bill total, which
-- is what the UI shows beside Bill Amount.
--
-- Added to both record tables so the shared bulk-update path in
-- matched-rules.routes.js stays uniform; only the IP batch-detail screen
-- surfaces them today.
ALTER TABLE ip_payment_records ADD COLUMN IF NOT EXISTS match_group_base_ref VARCHAR(255);
ALTER TABLE ip_payment_records ADD COLUMN IF NOT EXISTS match_group_member_count INTEGER;
ALTER TABLE ip_payment_records ADD COLUMN IF NOT EXISTS match_group_total NUMERIC(14,2);
ALTER TABLE ip_payment_records ADD COLUMN IF NOT EXISTS match_group_difference NUMERIC(14,2);

ALTER TABLE diag_op_payment_records ADD COLUMN IF NOT EXISTS match_group_base_ref VARCHAR(255);
ALTER TABLE diag_op_payment_records ADD COLUMN IF NOT EXISTS match_group_member_count INTEGER;
ALTER TABLE diag_op_payment_records ADD COLUMN IF NOT EXISTS match_group_total NUMERIC(14,2);
ALTER TABLE diag_op_payment_records ADD COLUMN IF NOT EXISTS match_group_difference NUMERIC(14,2);

-- ---------------------------------------------------------------------------
-- Bank-side match tracking: mirrors the payment-side match_status columns on
-- bank_statement_records, so "Generate" can run from the Bank Statement
-- batch-detail page and a bank row nothing claimed shows as UNMATCHED.
-- match_payment_record_id has no FK (points into ip or diag records per
-- match_payment_type: 'IP_PAYMENT' / 'DIAG_PAYMENT').
-- ---------------------------------------------------------------------------

ALTER TABLE bank_statement_records ADD COLUMN IF NOT EXISTS match_status VARCHAR(20);
ALTER TABLE bank_statement_records ADD COLUMN IF NOT EXISTS match_payment_type VARCHAR(16);
ALTER TABLE bank_statement_records ADD COLUMN IF NOT EXISTS match_payment_record_id INTEGER;
CREATE INDEX IF NOT EXISTS bank_statement_records_match_status_idx ON bank_statement_records(match_status);

ALTER TABLE bank_statement_uploads ADD COLUMN IF NOT EXISTS matched_at TIMESTAMP;

-- ---------------------------------------------------------------------------
-- Duplicate-upload guard. Every reconciliation upload endpoint stores the
-- SHA-256 of the file it ingested; re-uploading identical bytes is rejected
-- (see online-upload/dedupe.js). A combined bank workbook that becomes several
-- batches stores the same hash on each, so the whole file is caught as a unit.
-- ---------------------------------------------------------------------------
ALTER TABLE ip_payment_upload_batches        ADD COLUMN IF NOT EXISTS file_hash VARCHAR(64);
ALTER TABLE diag_op_upload_batches           ADD COLUMN IF NOT EXISTS file_hash VARCHAR(64);
ALTER TABLE bank_statement_uploads           ADD COLUMN IF NOT EXISTS file_hash VARCHAR(64);
ALTER TABLE online_upload_batches            ADD COLUMN IF NOT EXISTS file_hash VARCHAR(64);
CREATE INDEX IF NOT EXISTS ip_payment_upload_batches_file_hash_idx ON ip_payment_upload_batches(file_hash);
CREATE INDEX IF NOT EXISTS diag_op_upload_batches_file_hash_idx    ON diag_op_upload_batches(file_hash);
CREATE INDEX IF NOT EXISTS bank_statement_uploads_file_hash_idx    ON bank_statement_uploads(file_hash);

-- ---------------------------------------------------------------------------
-- PayU MPR (gateway settlement report) rides on the bank_statement_* tables:
-- an MPR row is the thing a gateway-UPI receipt reconciles against, exactly
-- the role a bank row plays for NEFT/IMPS. `source` tells the two apart so the
-- Bank Statement screens show only 'BANK' and a PayU MPR screen shows only
-- 'PAYU_MPR'; the matching engine reads both. For an MPR row:
--   chq_ref_no  = Merchant Txn ID   (the value the hospital MIS also records)
--   narration   = "MERCHANT <id> | PAYU <payuId> | BANKREF <bankRef> | <status>"
--   deposit_amt = gross Amount      (so it ties to the MIS receipt amount)
--   payu_id / settlement_utr        = kept for display and the later MPR<->bank step
-- ---------------------------------------------------------------------------
ALTER TABLE bank_statement_uploads ADD COLUMN IF NOT EXISTS source VARCHAR(16) NOT NULL DEFAULT 'BANK';
ALTER TABLE bank_statement_records ADD COLUMN IF NOT EXISTS source VARCHAR(16) NOT NULL DEFAULT 'BANK';
ALTER TABLE bank_statement_records ADD COLUMN IF NOT EXISTS payu_id VARCHAR(64);
ALTER TABLE bank_statement_records ADD COLUMN IF NOT EXISTS settlement_utr VARCHAR(64);
ALTER TABLE bank_statement_records ADD COLUMN IF NOT EXISTS net_amount NUMERIC(14,2);
CREATE INDEX IF NOT EXISTS bank_statement_uploads_source_idx ON bank_statement_uploads(source);
CREATE INDEX IF NOT EXISTS bank_statement_records_settlement_utr_idx ON bank_statement_records(settlement_utr) WHERE source = 'PAYU_MPR';

-- ---------------------------------------------------------------------------
-- Stage 2 of gateway-UPI reconciliation: MPR <-> Bank.
--
-- Stage 1 (elsewhere) matches each UPI receipt to one PayU MPR line. Stage 2
-- takes those MPR lines, groups them by the settlement UTR PayU quotes, sums
-- the per-line net amount, and ties that lump to the ONE bank credit that
-- carries the same UTR ("RTGS CR-...-PAYU PAYMENTS PVT LTD-...-<UTR>"). One
-- row per settlement batch; recomputed wholesale by POST
-- /api/matched-rules/payu-settlements/generate.
--
-- bank_record_id has no FK on purpose (mirrors match_payment_record_id): the
-- bank row can be deleted and re-uploaded independently of this rollup.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payu_settlements (
  settlement_utr   VARCHAR(64) PRIMARY KEY,
  line_count       INTEGER NOT NULL,
  gross_total      NUMERIC(14,2),
  net_total        NUMERIC(14,2),
  bank_record_id   INTEGER,
  bank_amount      NUMERIC(14,2),
  difference       NUMERIC(14,2),
  status           VARCHAR(20) NOT NULL,
  computed_at      TIMESTAMP NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- CHEQUE COLLECTION + REFUND DOCUMENT
--
-- Cheque money reconciles in two sequential stages against two different
-- documents:
--
--   Stage 1  cheque collection -> BANK STATEMENT, by cheque number + amount.
--   Stage 2  whatever Stage 1 could not match -> REFUND DOCUMENT. A cheque
--            collected and then refunded for the same patient and amount never
--            reaches a bank statement at all; it is a CONTRA ENTRY, not an
--            unreconciled receipt.
--
-- On the client's July HITECH CITY export that split is 4 / 195 / 44.
-- ---------------------------------------------------------------------------

-- Refund rows are REFERENCE DATA for Stage 2 and get standalone tables rather
-- than riding on bank_statement_records under a new `source`, the way the PayU
-- MPR does. The MPR earns that seat because an MPR line genuinely plays the
-- bank row's part: it is the counterparty a UPI receipt reconciles against. A
-- refund plays the opposite part, being evidence that money never reached the
-- bank. Concretely: loadBankRecords() has no source filter, so 4,278 refund
-- rows would join the candidate pool of every existing IP/Diag rule, and a
-- narration CONTAINS leaf could then return MATCHED against a document that is
-- not a bank statement -- a false reconciliation, persisted.
CREATE TABLE IF NOT EXISTS refund_upload_batches (
  id                SERIAL PRIMARY KEY,
  file_name         VARCHAR(255) NOT NULL,
  file_size_bytes   INTEGER NOT NULL,
  row_count         INTEGER NOT NULL DEFAULT 0,
  sheet_count       INTEGER NOT NULL DEFAULT 0,
  document_from     DATE,
  document_to       DATE,
  uploaded_by       VARCHAR(255),
  uploaded_at       TIMESTAMP NOT NULL DEFAULT now()
);

-- One workbook carries eight sheets -- four divisions x (IP, OP) -- so the
-- division is a property of the ROW here, not of the batch.
CREATE TABLE IF NOT EXISTS refund_records (
  id                SERIAL PRIMARY KEY,
  batch_id          INTEGER NOT NULL REFERENCES refund_upload_batches(id) ON DELETE CASCADE,
  sheet_name        VARCHAR(255),
  unit_name         VARCHAR(255),
  division          VARCHAR(64),
  refund_kind       VARCHAR(8),
  refund_no         VARCHAR(255),
  cheque_date       DATE,
  cheque_no         VARCHAR(255),
  patient_name      VARCHAR(255),
  drawee_name       VARCHAR(255),
  ip_no             VARCHAR(255),
  diag_no           VARCHAR(255),
  bank_name         VARCHAR(255),
  amount            NUMERIC(14,2),
  created_at        TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS refund_records_batch_id_idx  ON refund_records(batch_id);
CREATE INDEX IF NOT EXISTS refund_records_cheque_no_idx ON refund_records(cheque_no);
CREATE INDEX IF NOT EXISTS refund_records_ip_no_idx     ON refund_records(ip_no);

CREATE TABLE IF NOT EXISTS cheque_collection_upload_batches (
  id                SERIAL PRIMARY KEY,
  file_name         VARCHAR(255) NOT NULL,
  file_size_bytes   INTEGER NOT NULL,
  row_count         INTEGER NOT NULL DEFAULT 0,
  unit_name         VARCHAR(255),
  uploaded_by       VARCHAR(255),
  uploaded_at       TIMESTAMP NOT NULL DEFAULT now(),
  matched_at        TIMESTAMP
);

-- `receipt_date` is named to match ip/diag_op_payment_records deliberately:
-- computeMatchResults hard-codes that column in its date filter, so a cheque
-- table calling it anything else makes every dated query throw.
CREATE TABLE IF NOT EXISTS cheque_collection_records (
  id                     SERIAL PRIMARY KEY,
  batch_id               INTEGER NOT NULL REFERENCES cheque_collection_upload_batches(id) ON DELETE CASCADE,
  receipt_number         VARCHAR(255),
  receipt_date           DATE,
  cheque_date            DATE,
  ip_no                  VARCHAR(255),
  patient_name           VARCHAR(255),
  cheque_no              VARCHAR(255),
  pay_type               VARCHAR(255),
  bank_name              VARCHAR(255),
  branch_name            VARCHAR(255),
  cheque_amount          NUMERIC(14,2),
  user_id                VARCHAR(255),
  user_name              VARCHAR(255),
  created_at             TIMESTAMP NOT NULL DEFAULT now(),
  match_status           VARCHAR(20),
  match_applied_rule     VARCHAR(255),
  match_reason           TEXT,
  match_bank_record_id   INTEGER REFERENCES bank_statement_records(id) ON DELETE SET NULL,
  match_refund_record_id INTEGER REFERENCES refund_records(id)         ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS cheque_collection_records_batch_id_idx   ON cheque_collection_records(batch_id);
CREATE INDEX IF NOT EXISTS cheque_collection_records_status_idx     ON cheque_collection_records(match_status);
-- Both back-references MUST be indexed. Without them the ON DELETE SET NULL
-- above turns deleting a bank statement (or a refund upload) into a full scan
-- of this table per deleted row -- the same trap documented for
-- ip_payment_records above, which hung a delete for minutes.
CREATE INDEX IF NOT EXISTS cheque_collection_records_bank_ref_idx   ON cheque_collection_records(match_bank_record_id);
CREATE INDEX IF NOT EXISTS cheque_collection_records_refund_ref_idx ON cheque_collection_records(match_refund_record_id);

-- Duplicate-upload guard (see online-upload/dedupe.js) for the cheque & refund uploads too.
ALTER TABLE cheque_collection_upload_batches ADD COLUMN IF NOT EXISTS file_hash VARCHAR(64);
ALTER TABLE refund_upload_batches            ADD COLUMN IF NOT EXISTS file_hash VARCHAR(64);
CREATE INDEX IF NOT EXISTS cheque_collection_upload_batches_file_hash_idx ON cheque_collection_upload_batches(file_hash);
CREATE INDEX IF NOT EXISTS refund_upload_batches_file_hash_idx            ON refund_upload_batches(file_hash);

-- Default rules, one per stage. Guarded on name so a re-run never duplicates
-- them and never resurrects one the user deliberately deleted.
--
-- Stage 1 keys on the cheque number against the bank's Chq/Ref No or embedded
-- in the narration, and requires the amount to agree within a rupee. The
-- collection's own "Chq.Rcpt" is the Reference ID and is deliberately NOT a
-- join key: it is an internal receipt number the bank never sees.
INSERT INTO cheque_matching_rules (name, action, active, kind, condition_groups, contra_config, sort_order)
SELECT 'Cheque number matches bank statement', 'FORCE_MATCHED', true, 'CNF',
       '[[{"kind":"FIELD_PAIR","negate":false,"field":null,"operator":null,"value":null,"sourceField":"chequeNo","destinationField":"chqRefNo","pairOperator":"EQUALS","pairTolerance":null},
          {"kind":"FIELD_PAIR","negate":false,"field":null,"operator":null,"value":null,"sourceField":"chequeNo","destinationField":"narration","pairOperator":"CONTAINS","pairTolerance":null}],
         [{"kind":"FIELD_PAIR","negate":false,"field":null,"operator":null,"value":null,"sourceField":"chequeAmount","destinationField":"depositAmt","pairOperator":"AMOUNT_WITHIN_TOLERANCE","pairTolerance":"1"}]]'::jsonb,
       NULL,
       (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM cheque_matching_rules)
WHERE NOT EXISTS (SELECT 1 FROM cheque_matching_rules WHERE name = 'Cheque number matches bank statement');

-- Stage 2. scope NONE because the client asked for the refund search to cover
-- all four divisions; it is a setting rather than an omission, so the boundary
-- can be reinstated without a code change.
INSERT INTO cheque_matching_rules (name, action, active, kind, condition_groups, contra_config, sort_order)
SELECT 'Contra entry against refund document', 'CONTRA_ENTRY', true, 'CONTRA_ENTRY',
       NULL,
       '{"keyFields":["chequeNo","ipNo"],"amountField":"chequeAmount","tolerance":0,
         "dateWindowDays":null,"scope":"NONE","onAmbiguous":"UNMATCHED"}'::jsonb,
       (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM cheque_matching_rules)
WHERE NOT EXISTS (SELECT 1 FROM cheque_matching_rules WHERE name = 'Contra entry against refund document');

-- Stage 2, second pass: cheque number + amount, with the IP number dropped.
--
-- Yashoda's own cheque series (Type "Yash") is issued as a refund and then
-- collected back against a DIFFERENT admission, so the collection's IP No and
-- the refund's IP No genuinely disagree -- and for an outpatient refund the
-- identity column is a Diag No, which an IP No can never equal. The cheque
-- number and the amount still agree exactly, and a cheque number is unique to
-- one instrument, so the pair identifies the refund on its own.
--
-- Ordered AFTER the strict rule, never instead of it. Measured on the July HTC
-- export: strict-then-loose accounts for 231 of 243 receipts, where running
-- this rule alone accounts for only 222 -- on its own it lets a loose match
-- consume a refund line that the strict rule would have paired correctly, and
-- the stricter pairing is then lost. Rule order is doing real work here.
INSERT INTO cheque_matching_rules (name, action, active, kind, condition_groups, contra_config, sort_order)
SELECT 'Contra entry - cheque number and amount', 'CONTRA_ENTRY', true, 'CONTRA_ENTRY',
       NULL,
       '{"keyFields":["chequeNo"],"amountField":"chequeAmount","tolerance":0,
         "dateWindowDays":null,"scope":"NONE","onAmbiguous":"UNMATCHED"}'::jsonb,
       (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM cheque_matching_rules)
WHERE NOT EXISTS (SELECT 1 FROM cheque_matching_rules WHERE name = 'Contra entry - cheque number and amount');

-- ---------------------------------------------------------------------------
-- Cheque collection: DIAGNOSTICS as well as inpatient.
--
-- The two reports are different layouts, not variants of one: the diagnostics
-- export is keyed on a Diag No, carries no cheque date and no payer type, and
-- has TWO amounts (Rcpt.Amt and Cheque.Amt) that genuinely disagree.
--
-- They share ONE table rather than getting a second the way IP and Diag
-- payments did, because a contra key part that is blank makes contraKey return
-- null: an ipNo-keyed rule therefore skips diagnostics rows of its own accord,
-- and a diagNo-keyed rule skips inpatient ones. No discriminator column has to
-- be consulted by the engine, and one rule set governs both.
--
-- Measured before building: cheque + Diag No + amount matches NOTHING across
-- all four divisions, while cheque + amount alone matches 8. Same shape as the
-- inpatient side -- a Yashoda refund cheque is raised against one episode and
-- collected against another, so only the instrument and the money agree. So no
-- diagnostics-specific rule is seeded; the existing cheque + amount rule
-- already covers it.
-- ---------------------------------------------------------------------------
ALTER TABLE cheque_collection_upload_batches ADD COLUMN IF NOT EXISTS collection_kind VARCHAR(8);

ALTER TABLE cheque_collection_records ADD COLUMN IF NOT EXISTS collection_kind VARCHAR(8);
ALTER TABLE cheque_collection_records ADD COLUMN IF NOT EXISTS diag_no VARCHAR(255);
ALTER TABLE cheque_collection_records ADD COLUMN IF NOT EXISTS pat_type VARCHAR(255);
-- Rcpt.Amt, kept beside Cheque.Amt rather than instead of it. The cheque
-- amount is what reconciles (it is the instrument that cleared or was
-- refunded); the receipt amount is what the patient was billed, and a reviewer
-- needs to see both when they differ.
ALTER TABLE cheque_collection_records ADD COLUMN IF NOT EXISTS receipt_amount NUMERIC(14,2);

CREATE INDEX IF NOT EXISTS cheque_collection_records_diag_no_idx ON cheque_collection_records(diag_no);

-- Rows loaded before this column existed are all inpatient, by definition.
UPDATE cheque_collection_records SET collection_kind = 'IP' WHERE collection_kind IS NULL;
UPDATE cheque_collection_upload_batches SET collection_kind = 'IP' WHERE collection_kind IS NULL;

-- ---------------------------------------------------------------------------
-- EaseBuzz Settlement Report.
--
-- Unlike the PayU MPR (one row per transaction, grouped into a settlement by
-- reconciliation/payu-settlement.js), EaseBuzz's own settlement export is
-- already ONE ROW PER SETTLEMENT BATCH -- there is no per-transaction line to
-- group. So this rides on its own dedicated tables (the payu_settlements
-- shape, but uploaded rather than computed) instead of bank_statement_records:
-- a settlement row is not itself a bank-side candidate the CNF engine should
-- ever join a payment against, it is closer to a reference document like the
-- refund workbook.
--
-- `bank_id` is the join key to the real bank credit -- verified against live
-- data: it equals the credit's chq_ref_no exactly, and where matched the
-- credit's deposit_amt equals this report's settled_amount to the rupee.
-- `settlement_date` is therefore the true "Date of Realisation" for the
-- settlement as a whole.
--
-- ATTRIBUTION, as of 2026-09-15. Neither report carries a reference tying a
-- transaction to a settlement (tested exhaustively: 0 of 269). But the DAY is
-- derivable and exact: a settlement day pays out every EaseBuzz transaction
-- since the PREVIOUS settlement day -- verified 78/78 to the rupee by
-- scripts/verify-easebuzz-windows.js, and implemented once in
-- reconciliation/easebuzz-settlement.js (settlementWindows / settlementDateFor).
-- The audit report uses it so an EaseBuzz receipt's Date of Realisation is the
-- payout date rather than the customer's payment date.
--
-- What is still NOT determinable is which individual receipts make up one
-- settlement when a day carries several -- only 18% of such days have a unique
-- subset -- so anything per-settlement stays advisory and says so.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS easebuzz_settlement_upload_batches (
  id                SERIAL PRIMARY KEY,
  file_name         VARCHAR(255) NOT NULL,
  file_size_bytes   INTEGER NOT NULL,
  row_count         INTEGER NOT NULL DEFAULT 0,
  uploaded_by       VARCHAR(255),
  uploaded_at       TIMESTAMP NOT NULL DEFAULT now(),
  matched_at        TIMESTAMP,
  file_hash         VARCHAR(64)
);

CREATE INDEX IF NOT EXISTS easebuzz_settlement_upload_batches_file_hash_idx ON easebuzz_settlement_upload_batches(file_hash);

CREATE TABLE IF NOT EXISTS easebuzz_settlement_records (
  id                      SERIAL PRIMARY KEY,
  batch_id                INTEGER NOT NULL REFERENCES easebuzz_settlement_upload_batches(id) ON DELETE CASCADE,
  settlement_id           VARCHAR(64),
  bank_id                 VARCHAR(64),
  account_number          VARCHAR(64),
  bank_name               VARCHAR(255),
  total_amount            NUMERIC(14,2),
  service_charge          NUMERIC(14,2),
  gst                     NUMERIC(14,2),
  refund_amount           NUMERIC(14,2),
  settled_amount          NUMERIC(14,2),
  paid                    BOOLEAN,
  settlement_date         TIMESTAMP,
  express_service_charge  NUMERIC(14,2),
  express_service_tax     NUMERIC(14,2),
  match_status            VARCHAR(20),
  match_bank_record_id    INTEGER REFERENCES bank_statement_records(id) ON DELETE SET NULL,
  match_reason            TEXT,
  created_at              TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS easebuzz_settlement_records_batch_id_idx ON easebuzz_settlement_records(batch_id);
-- Indexed for the same reason documented on ip_payment_records' equivalent
-- back-reference: without it, deleting a bank statement forces a full scan of
-- this table for every ON DELETE SET NULL cascade row.
CREATE INDEX IF NOT EXISTS easebuzz_settlement_records_bank_ref_idx ON easebuzz_settlement_records(match_bank_record_id);
CREATE INDEX IF NOT EXISTS easebuzz_settlement_records_status_idx ON easebuzz_settlement_records(match_status);

-- ---------------------------------------------------------------------------
-- UPI & Card Reconciliation (UCR). A wholly SEPARATE reconciliation module,
-- deliberately not wired into ip_payment_records / diag_op_payment_records /
-- bank_statement_records / reconciliation/rules.js (the main CNF engine).
-- The client's own HIS export can produce a different, richer MIS report —
-- one row per payment INSTRUMENT (a split-payment receipt appears as several
-- rows), each carrying a `Reference ID` that is the processor's own approval
-- code (Card) or RRN (UPI) — verified directly against a real weekly export.
-- ucr_ip_records is the MIS-side; ucr_card_mpr_records / ucr_card_pinelabs_records
-- / ucr_upi_mpr_records are the three processor/gateway sides it is matched
-- against. Despite the table name, ucr_ip_records holds rows from THREE MIS
-- sources — IP, OP and DIAG — distinguished by `mis_source`. OP and DIAG are
-- each a genuinely different raw HIS export from IP, each with its own
-- header/data column-shift quirk solved by direct row-by-row verification
-- against real data (see ucr-op-parser.js / ucr-diag-parser.js). Sharing one
-- table (rather than a sibling ucr_op_records/ucr_diag_records pair) keeps
-- Card/UPI matching automatic across all three sources with no route changes
-- — the matchers already just query `WHERE instrument_type = 'CARD'/'UPI'`.
--
-- DIAG in particular only contributes a Card pathway, not UPI — see
-- ucr-diag-parser.js's header comment for why (its "UPI" amount bucket never
-- carries a reference anywhere in the row, confirmed against the real file;
-- its "Online" bucket is where genuine Card transactions turned out to be,
-- confirmed by two exact matches against real CARD MPR/Pine Labs rows).
--
-- match_status/match_source_type/match_source_id/match_reason live on the
-- MIS-side row (ucr_ip_records), same reasoning as easebuzz_settlement_records
-- above: the uploaded MIS row IS the reconciled entity, not a grouping rolled
-- up into a derived table. match_source_type + match_source_id (no FK — a
-- Card row can point at either ucr_card_mpr_records or
-- ucr_card_pinelabs_records) mirrors the existing polymorphic
-- match_payment_type/match_payment_record_id pattern already used elsewhere.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ucr_ip_upload_batches (
  id                SERIAL PRIMARY KEY,
  file_name         VARCHAR(255) NOT NULL,
  file_size_bytes   INTEGER NOT NULL,
  row_count         INTEGER NOT NULL DEFAULT 0,
  uploaded_by       VARCHAR(255),
  uploaded_at       TIMESTAMP NOT NULL DEFAULT now(),
  matched_at        TIMESTAMP,
  file_hash         VARCHAR(64)
);

-- Added after the table's first release (OP/DIAG support came later) — ALTER
-- rather than a CREATE TABLE column, since IF NOT EXISTS on CREATE TABLE is a
-- no-op once the table already exists on a live database.
ALTER TABLE ucr_ip_upload_batches ADD COLUMN IF NOT EXISTS mis_source VARCHAR(10) NOT NULL DEFAULT 'IP'; -- 'IP' | 'OP' | 'DIAG'

CREATE INDEX IF NOT EXISTS ucr_ip_upload_batches_file_hash_idx ON ucr_ip_upload_batches(file_hash);
CREATE INDEX IF NOT EXISTS ucr_ip_upload_batches_mis_source_idx ON ucr_ip_upload_batches(mis_source);

CREATE TABLE IF NOT EXISTS ucr_ip_records (
  id                  SERIAL PRIMARY KEY,
  batch_id            INTEGER NOT NULL REFERENCES ucr_ip_upload_batches(id) ON DELETE CASCADE,
  receipt_no          VARCHAR(255),
  receipt_date        TIMESTAMP,
  yh_no               VARCHAR(255),
  ip_no               VARCHAR(255),
  patient_name        VARCHAR(255),
  bill_no             VARCHAR(255),
  instrument_type     VARCHAR(20),   -- 'CARD' | 'UPI' — only these two are ingested
  amount              NUMERIC(14,2),
  user_id             VARCHAR(255),
  user_name           VARCHAR(255),
  reference_id        VARCHAR(64),   -- Card approval code, or UPI RRN
  match_status        VARCHAR(20),
  match_source_type   VARCHAR(20),   -- 'CARD_MPR' | 'CARD_PINELABS' | 'UPI_MPR'
  match_source_id     INTEGER,       -- no FK: polymorphic across 3 possible tables
  match_reason        TEXT,
  created_at          TIMESTAMP NOT NULL DEFAULT now()
);

-- Same reasoning as ucr_ip_upload_batches.mis_source above.
ALTER TABLE ucr_ip_records ADD COLUMN IF NOT EXISTS mis_source VARCHAR(10) NOT NULL DEFAULT 'IP'; -- denormalized for easy filtering, no join needed
ALTER TABLE ucr_ip_records ADD COLUMN IF NOT EXISTS diag_no VARCHAR(255); -- DIAG only

-- The card/UPI matchers already compute a per-group shortfall but previously
-- discarded it, leaving the number recoverable only by re-parsing the prose in
-- match_reason. The audit report needs it as a real column.
--
-- IMPORTANT: this is the GROUP figure. Several receipts can share one reference
-- (a split payment), and the verdict is decided on their summed amount — so
-- match_group_amount is the sum over the reference, not this row's own amount,
-- and recomputing the difference per row would contradict match_status.
ALTER TABLE ucr_ip_records ADD COLUMN IF NOT EXISTS match_difference   NUMERIC(14,2);
ALTER TABLE ucr_ip_records ADD COLUMN IF NOT EXISTS match_group_amount NUMERIC(14,2);
-- The gateway-side counterpart to match_group_amount: what the matcher actually
-- compared match_group_amount against. Usually equal to the single joined
-- gateway row's own amount (msrc_amount in ucr-record-query.js) — but a
-- reference can carry MORE THAN ONE real gateway settlement at once (a 6-digit
-- CARD approval code gets reissued to unrelated transactions; confirmed live:
-- app_code 705447 is two real settlements four days apart). When that happens
-- match_source_id can only point at one of them (it is a single FK), so the
-- live join alone would show a number that disagrees with match_difference —
-- this column is what GROUPED_MATCHED actually reconciled against, persisted
-- once at Generate time rather than re-derived (and risking drifting from the
-- matcher's own normalizeRef logic) on every read.
ALTER TABLE ucr_ip_records ADD COLUMN IF NOT EXISTS match_source_amount NUMERIC(14,2);

CREATE INDEX IF NOT EXISTS ucr_ip_records_batch_id_idx ON ucr_ip_records(batch_id);
CREATE INDEX IF NOT EXISTS ucr_ip_records_status_idx ON ucr_ip_records(match_status);
CREATE INDEX IF NOT EXISTS ucr_ip_records_reference_id_idx ON ucr_ip_records(reference_id);
CREATE INDEX IF NOT EXISTS ucr_ip_records_mis_source_idx ON ucr_ip_records(mis_source);

CREATE TABLE IF NOT EXISTS ucr_card_mpr_upload_batches (
  id                SERIAL PRIMARY KEY,
  file_name         VARCHAR(255) NOT NULL,
  file_size_bytes   INTEGER NOT NULL,
  row_count         INTEGER NOT NULL DEFAULT 0,
  uploaded_by       VARCHAR(255),
  uploaded_at       TIMESTAMP NOT NULL DEFAULT now(),
  matched_at        TIMESTAMP,
  file_hash         VARCHAR(64)
);

CREATE INDEX IF NOT EXISTS ucr_card_mpr_upload_batches_file_hash_idx ON ucr_card_mpr_upload_batches(file_hash);

-- Merchant Payout Report for card transactions (Visa/Mastercard/RuPay etc, via
-- the bank's own processing system — confirmed distinct from Pine Labs below).
-- app_code is the join key to ucr_ip_records.reference_id (Card rows).
-- pymt_chgamnt is the GROSS charged amount — confirmed equal to the MIS amount
-- on a real matched pair; pymt_netamnt is net of commission+GST and is NOT
-- the amount to compare against MIS.
CREATE TABLE IF NOT EXISTS ucr_card_mpr_records (
  id                  SERIAL PRIMARY KEY,
  batch_id            INTEGER NOT NULL REFERENCES ucr_card_mpr_upload_batches(id) ON DELETE CASCADE,
  mecode              VARCHAR(64),
  me_name             VARCHAR(255),
  cardnbr             VARCHAR(64),
  legal_name          VARCHAR(255),
  chg_date            DATE,
  process_date        DATE,
  terminal_no         VARCHAR(64),
  stall_no            VARCHAR(64),
  grp_desc            VARCHAR(255),
  app_code            VARCHAR(64),
  pymt_chgamnt        NUMERIC(14,2),
  pymt_comm           NUMERIC(14,2),
  pymt_servtax        NUMERIC(14,2),
  pymt_cgst           NUMERIC(14,2),
  pymt_sgst           NUMERIC(14,2),
  pymt_igst           NUMERIC(14,2),
  pymt_utgst          NUMERIC(14,2),
  pymt_netamnt        NUMERIC(14,2),
  debitcredit_type    VARCHAR(8),
  arn                 VARCHAR(64),
  invoice_number      VARCHAR(64),
  transaction_id      VARCHAR(64),
  created_at          TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ucr_card_mpr_records_batch_id_idx ON ucr_card_mpr_records(batch_id);
CREATE INDEX IF NOT EXISTS ucr_card_mpr_records_app_code_idx ON ucr_card_mpr_records(app_code);

CREATE TABLE IF NOT EXISTS ucr_card_pinelabs_upload_batches (
  id                SERIAL PRIMARY KEY,
  file_name         VARCHAR(255) NOT NULL,
  file_size_bytes   INTEGER NOT NULL,
  row_count         INTEGER NOT NULL DEFAULT 0,
  uploaded_by       VARCHAR(255),
  uploaded_at       TIMESTAMP NOT NULL DEFAULT now(),
  matched_at        TIMESTAMP,
  file_hash         VARCHAR(64)
);

CREATE INDEX IF NOT EXISTS ucr_card_pinelabs_upload_batches_file_hash_idx ON ucr_card_pinelabs_upload_batches(file_hash);

-- Pine Labs POS terminal export. Despite files typically being named "AMEX...",
-- confirmed this covers MULTIPLE acquirers/networks in one file (AMEX and
-- RBL_DCC both seen for real) — `acquirer` records which. approval_code is the
-- join key, same semantics as ucr_card_mpr_records.app_code. RBL_DCC rows are a
-- Dynamic Currency Conversion product (currency = 'DCC_INR') — gross-to-gross
-- amount parity for those specifically is unverified, not confirmed; flagged,
-- not assumed.
CREATE TABLE IF NOT EXISTS ucr_card_pinelabs_records (
  id                  SERIAL PRIMARY KEY,
  batch_id            INTEGER NOT NULL REFERENCES ucr_card_pinelabs_upload_batches(id) ON DELETE CASCADE,
  zone                VARCHAR(64),
  store_name          VARCHAR(255),
  city                VARCHAR(128),
  acquirer            VARCHAR(32),
  tid                 VARCHAR(64),
  mid                 VARCHAR(64),
  batch_no            VARCHAR(64),
  payment_mode        VARCHAR(64),
  cardholder_name     VARCHAR(255),
  card_issuer         VARCHAR(255),
  card_type           VARCHAR(64),
  card_network        VARCHAR(64),
  transaction_id      VARCHAR(64),
  invoice             VARCHAR(64),
  approval_code       VARCHAR(64),
  amount              NUMERIC(14,2),
  currency            VARCHAR(16),
  txn_date            TIMESTAMP,
  txn_status          VARCHAR(32),
  settlement_date     DATE,
  rrn                 VARCHAR(64),
  created_at          TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ucr_card_pinelabs_records_batch_id_idx ON ucr_card_pinelabs_records(batch_id);
CREATE INDEX IF NOT EXISTS ucr_card_pinelabs_records_approval_code_idx ON ucr_card_pinelabs_records(approval_code);

CREATE TABLE IF NOT EXISTS ucr_upi_mpr_upload_batches (
  id                SERIAL PRIMARY KEY,
  file_name         VARCHAR(255) NOT NULL,
  file_size_bytes   INTEGER NOT NULL,
  row_count         INTEGER NOT NULL DEFAULT 0,
  uploaded_by       VARCHAR(255),
  uploaded_at       TIMESTAMP NOT NULL DEFAULT now(),
  matched_at        TIMESTAMP,
  file_hash         VARCHAR(64)
);

CREATE INDEX IF NOT EXISTS ucr_upi_mpr_upload_batches_file_hash_idx ON ucr_upi_mpr_upload_batches(file_hash);

-- The bank_statement_uploads mirror this UPI batch created (ucr-upload.routes.js,
-- upi-mpr beforeRecords) — deleting the UPI batch deletes the mirror too.
ALTER TABLE ucr_upi_mpr_upload_batches ADD COLUMN IF NOT EXISTS bank_batch_id INTEGER REFERENCES bank_statement_uploads(id) ON DELETE SET NULL;

-- UPI Merchant Payout Report. rrn ("Txn ref no. (RRN)") is the join key to
-- ucr_ip_records.reference_id (UPI rows). transaction_amount is GROSS and
-- confirmed equal to the MIS amount on a real matched pair; net_amount is net
-- of MSF/GST. trans_type/cr_dr carry CREDIT/PAY refund pairs (same order_id,
-- equal amount) that the matcher must exclude, not treat as unmatched.
CREATE TABLE IF NOT EXISTS ucr_upi_mpr_records (
  id                      SERIAL PRIMARY KEY,
  batch_id                INTEGER NOT NULL REFERENCES ucr_upi_mpr_upload_batches(id) ON DELETE CASCADE,
  external_mid            VARCHAR(64),
  external_tid            VARCHAR(64),
  merchant_vpa            VARCHAR(255),
  payer_vpa               VARCHAR(255),
  upi_trxn_id             VARCHAR(64),
  order_id                VARCHAR(64),
  rrn                     VARCHAR(64),
  transaction_req_date    TIMESTAMP,
  settlement_date         DATE,
  transaction_amount      NUMERIC(14,2),
  msf_amount              NUMERIC(14,2),
  net_amount              NUMERIC(14,2),
  trans_type              VARCHAR(32),
  pay_type                VARCHAR(32),
  cr_dr                   VARCHAR(8),
  created_at              TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ucr_upi_mpr_records_batch_id_idx ON ucr_upi_mpr_records(batch_id);
CREATE INDEX IF NOT EXISTS ucr_upi_mpr_records_rrn_idx ON ucr_upi_mpr_records(rrn);
CREATE INDEX IF NOT EXISTS ucr_upi_mpr_records_order_id_idx ON ucr_upi_mpr_records(order_id);

-- ---------------------------------------------------------------------------
-- GATEWAY / SETTLEMENT MATCHING POLICY
--
-- The four gateway matchers -- card, upi, payu, easebuzz -- were the only
-- reconciliation code in FRS that was not configurable: tolerance was a
-- hardcoded `= 1`, the narration-token floor a bare `>= 8`, a policy could not
-- be switched off, and an ambiguous multi-candidate case always silently picked
-- the nearest amount. This table holds their policy.
--
-- DELIBERATELY SEPARATE from ip/diag/upi/cheque_matching_rules. Those four are
-- driven by computeMatchResults (CNF + unit + contra passes); these four
-- matchers never run through it -- they are standalone functions called from
-- their own routes. Keeping their policy here means the shared rule machinery
-- (mountRuleCrud, matchingRuleRowToApi, RULE_KIND_SPECS, the kind CHECK above)
-- is not touched at all, so nothing that works today can be disturbed. It also
-- needs no `kind` column and none of the three unused payload columns.
--
-- gateway_config carries POLICY ONLY, never field wiring -- which processor
-- column joins to which MIS column is a fact about the file format, verified
-- against real client files, not a preference. See
-- src/reconciliation/gateway-policy.js for the key vocabulary and the
-- per-target defaults, which reproduce the previous hardcoded behaviour exactly.
--
-- Semantics: the FIRST ACTIVE rule for a target wins (sort_order, then id). No
-- rows, or all inactive, falls back to those built-in defaults -- never
-- "refuse to run", because a disabled rule must not silently zero out a
-- month's reconciliation.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gateway_matching_rules (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(255) NOT NULL,
  target          VARCHAR(16)  NOT NULL,   -- CARD | UPI | PAYU | EASEBUZZ
  active          BOOLEAN      NOT NULL DEFAULT true,
  sort_order      INTEGER,
  gateway_config  JSONB        NOT NULL,
  created_at      TIMESTAMP    NOT NULL DEFAULT now(),
  updated_at      TIMESTAMP    NOT NULL DEFAULT now()
);

-- Dropped and re-added rather than guarded, like every other constraint in this
-- file, so re-running converges from any state.
ALTER TABLE gateway_matching_rules DROP CONSTRAINT IF EXISTS gateway_matching_rules_target_chk;
ALTER TABLE gateway_matching_rules ADD CONSTRAINT gateway_matching_rules_target_chk
  CHECK (target IN ('CARD', 'UPI', 'PAYU', 'EASEBUZZ'));

CREATE INDEX IF NOT EXISTS gateway_matching_rules_target_idx
  ON gateway_matching_rules(target, sort_order);

-- One seeded policy per target, each reproducing today's hardcoded behaviour to
-- the paise. Guarded on TARGET rather than name: a fresh or upgraded DB always
-- ends with exactly one working policy per target. The trade-off is that
-- deleting a target's only rule and restarting restores this default -- which is
-- the safe direction, since the alternative is a target with no policy at all.
INSERT INTO gateway_matching_rules (name, target, active, sort_order, gateway_config)
SELECT 'Default card policy', 'CARD', true, 1,
       '{"tolerance":1,"onAmbiguous":"NEAREST_AMOUNT"}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM gateway_matching_rules WHERE target = 'CARD');

INSERT INTO gateway_matching_rules (name, target, active, sort_order, gateway_config)
SELECT 'Default UPI policy', 'UPI', true, 1,
       '{"tolerance":1,"onAmbiguous":"NEAREST_AMOUNT","excludeRefundPairs":true}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM gateway_matching_rules WHERE target = 'UPI');

INSERT INTO gateway_matching_rules (name, target, active, sort_order, gateway_config)
SELECT 'Default PayU settlement policy', 'PAYU', true, 1,
       '{"tolerance":1,"onAmbiguous":"NEAREST_AMOUNT","useNarrationTokens":true,"minTokenLength":8,"compareAmount":"NET"}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM gateway_matching_rules WHERE target = 'PAYU');

INSERT INTO gateway_matching_rules (name, target, active, sort_order, gateway_config)
SELECT 'Default EaseBuzz settlement policy', 'EASEBUZZ', true, 1,
       '{"tolerance":1,"onAmbiguous":"NEAREST_AMOUNT","useNarrationTokens":true,"minTokenLength":8}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM gateway_matching_rules WHERE target = 'EASEBUZZ');

-- ---------------------------------------------------------------------------
-- Users, locations (branches) and audit trail — the only login there is (the
-- old hardcoded demo accounts were retired 2026-09-21). `locations` mirrors the division list already
-- hardcoded on master_division_bank_accounts's CHECK constraint above — same
-- 4 names, now a real add/deactivate-able master instead of a fixed enum.
--
-- Role model: 'Admin' | 'Auditor'. Admin always sees every location (no
-- explicit grant needed, checked in application code the same way the
-- reference RBAC app treats role='admin' as full-access) — user_locations
-- rows are only meaningful for Auditors. manager_id is a self-reference so a
-- user's reporting manager (name + id) can be shown without a separate role.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS locations (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(64) NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMP NOT NULL DEFAULT now(),
  updated_at  TIMESTAMP NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS locations_name_key ON locations(name);

INSERT INTO locations (name) VALUES
  ('Hitech City'), ('Somajiguda'), ('Secunderabad'), ('Malakpet')
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS users (
  id                     SERIAL PRIMARY KEY,
  employee_id            VARCHAR(20) NOT NULL,
  username               VARCHAR(50) NOT NULL,
  password_hash          TEXT NOT NULL,
  full_name              VARCHAR(150) NOT NULL,
  role                   VARCHAR(16) NOT NULL DEFAULT 'Auditor',
  manager_id             INTEGER REFERENCES users(id) ON DELETE SET NULL,
  email                  VARCHAR(150),
  mobile_number          VARCHAR(20),
  is_active              BOOLEAN NOT NULL DEFAULT true,
  must_change_password   BOOLEAN NOT NULL DEFAULT true,
  failed_login_attempts  INTEGER NOT NULL DEFAULT 0,
  locked_until           TIMESTAMP,
  last_login_at          TIMESTAMP,
  created_at             TIMESTAMP NOT NULL DEFAULT now(),
  updated_at             TIMESTAMP NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_username_key ON users(LOWER(username));
CREATE UNIQUE INDEX IF NOT EXISTS users_employee_id_key ON users(LOWER(employee_id));

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_chk;
ALTER TABLE users ADD CONSTRAINT users_role_chk CHECK (role IN ('Admin', 'Auditor'));

CREATE TABLE IF NOT EXISTS user_locations (
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id  INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  granted_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  granted_at   TIMESTAMP NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, location_id)
);

-- target_user_id covers the original "one account acted on another account"
-- case (login, user CRUD, branch grants). entity_type/entity_id generalise
-- beyond users — a location deactivated, a bank account edited, a matching
-- rule changed, a reconciliation record moved from Unmatched to Matched —
-- so this one table can back a whole-application audit log, not just a
-- per-user activity list. Both are nullable and independent: a row sets
-- target_user_id, entity_type/entity_id, both, or neither (e.g. LOGIN_FAILED
-- with a typo'd username has no resolvable target at all).
CREATE TABLE IF NOT EXISTS audit_logs (
  id              SERIAL PRIMARY KEY,
  actor_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  target_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  entity_type     VARCHAR(50),
  entity_id       VARCHAR(50),
  action          VARCHAR(50) NOT NULL,
  details         JSONB,
  ip_address      VARCHAR(45),
  created_at      TIMESTAMP NOT NULL DEFAULT now()
);

ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS entity_type VARCHAR(50);
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS entity_id VARCHAR(50);

CREATE INDEX IF NOT EXISTS audit_logs_actor_idx   ON audit_logs(actor_user_id);
CREATE INDEX IF NOT EXISTS audit_logs_target_idx  ON audit_logs(target_user_id);
CREATE INDEX IF NOT EXISTS audit_logs_entity_idx  ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs(created_at DESC);

-- ---------------------------------------------------------------------------
-- Maker-checker for mismatch resolution (client mail 2026-09-21, point 2):
-- an Auditor ("maker") proposes changing a mismatched record to Matched with
-- a mandatory reason; their own Reporting Manager ("checker",
-- users.manager_id) approves or rejects it. One shared table across all 5
-- collection types (IP/DIAG/CHEQUE/CARD/UPI), same generalisation approach as
-- audit_logs' entity_type/entity_id — a checker's pending-approval queue has
-- to span every type in one query, the same reason online-mismatches unions
-- IP+DIAG rather than keeping them apart.
--
-- locked_at/locked_by on each record table (below) is what actually protects
-- an approved correction: every Generate re-run's bulk UPDATE must skip a
-- locked row, or the next Generate silently overwrites what the checker just
-- signed off on. See bulkUpdateMatchStatus / bulkUpdateChequeMatchStatus in
-- matched-rules.routes.js and the two generate routes in ucr-matched.routes.js.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS match_change_requests (
  id               SERIAL PRIMARY KEY,
  entity_type      VARCHAR(10) NOT NULL,
  entity_id        INTEGER NOT NULL,
  previous_status  VARCHAR(20) NOT NULL,
  proposed_status  VARCHAR(20) NOT NULL DEFAULT 'MATCHED',
  reason           TEXT NOT NULL,
  -- Nullable, same reasoning as audit_logs.actor_user_id: deleting the user
  -- who made the request must anonymise the row, not cascade-delete the
  -- request itself (and NOT NULL + ON DELETE SET NULL is a contradiction —
  -- deleting the referenced user would try to null out a NOT NULL column).
  requested_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  requested_at     TIMESTAMP NOT NULL DEFAULT now(),
  status           VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  reviewed_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at      TIMESTAMP,
  review_note      TEXT
);

-- Fixes an already-deployed version of this table created with requested_by
-- NOT NULL (see the comment on that column above) — CREATE TABLE IF NOT
-- EXISTS above won't touch an existing table's column constraints.
ALTER TABLE match_change_requests ALTER COLUMN requested_by DROP NOT NULL;

ALTER TABLE match_change_requests DROP CONSTRAINT IF EXISTS match_change_requests_entity_type_chk;
ALTER TABLE match_change_requests ADD CONSTRAINT match_change_requests_entity_type_chk
  CHECK (entity_type IN ('IP', 'DIAG', 'CHEQUE', 'CARD', 'UPI'));

ALTER TABLE match_change_requests DROP CONSTRAINT IF EXISTS match_change_requests_status_chk;
ALTER TABLE match_change_requests ADD CONSTRAINT match_change_requests_status_chk
  CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED'));

-- Only one open request per record at a time — a second proposal on the same
-- row must wait for (or replace, by rejecting first) the pending one.
CREATE UNIQUE INDEX IF NOT EXISTS match_change_requests_one_pending
  ON match_change_requests(entity_type, entity_id) WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS match_change_requests_requested_by_idx ON match_change_requests(requested_by);
CREATE INDEX IF NOT EXISTS match_change_requests_status_idx       ON match_change_requests(status);

ALTER TABLE ip_payment_records        ADD COLUMN IF NOT EXISTS locked_at TIMESTAMP;
ALTER TABLE ip_payment_records        ADD COLUMN IF NOT EXISTS locked_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE diag_op_payment_records   ADD COLUMN IF NOT EXISTS locked_at TIMESTAMP;
ALTER TABLE diag_op_payment_records   ADD COLUMN IF NOT EXISTS locked_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE cheque_collection_records ADD COLUMN IF NOT EXISTS locked_at TIMESTAMP;
ALTER TABLE cheque_collection_records ADD COLUMN IF NOT EXISTS locked_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE ucr_ip_records            ADD COLUMN IF NOT EXISTS locked_at TIMESTAMP;
ALTER TABLE ucr_ip_records            ADD COLUMN IF NOT EXISTS locked_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- Grouped cheques (client mail 2026-09-28, cheque 127760): one cheque paying
-- several receipts is matched by a grouped-total rule keyed on the cheque
-- number. Same match_group_* columns as the IP/Diag record tables, so the
-- shared mapper exposes the group, and a row whose member count is above 1
-- reads "Grouped Matched".
ALTER TABLE cheque_collection_records ADD COLUMN IF NOT EXISTS match_group_base_ref VARCHAR(255);
ALTER TABLE cheque_collection_records ADD COLUMN IF NOT EXISTS match_group_member_count INTEGER;
ALTER TABLE cheque_collection_records ADD COLUMN IF NOT EXISTS match_group_total NUMERIC(14,2);
ALTER TABLE cheque_collection_records ADD COLUMN IF NOT EXISTS match_group_difference NUMERIC(14,2);

-- ---------------------------------------------------------------------------
-- Shared-folder automation (client mail 2026-09-21, point 3): the client
-- drops files into one network folder; the app checks it at a scheduled
-- time each day, auto-detects each file (detect-file-type.js, same as the
-- manual Upload & Run screen), ingests it through the existing upload
-- routes, then runs the existing Generate routes for whatever came in — see
-- backend/src/folder-watch/. One row in folder_watch_config (one folder, per
-- the client's "a new screen" wording), a run history in folder_watch_runs,
-- and per-file detail in folder_watch_run_files.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS folder_watch_config (
  id                 SERIAL PRIMARY KEY,
  folder_path        TEXT NOT NULL,
  -- Wall-clock IST time of day, e.g. '06:00:00' — the scheduler explicitly
  -- treats this as IST when computing the next run, never the server OS's
  -- local timezone (see frs-date-timezone-trap; this project has been bitten
  -- by implicit-timezone bugs before).
  run_time           TIME NOT NULL DEFAULT '06:00:00',
  active             BOOLEAN NOT NULL DEFAULT true,
  uploaded_by_label  VARCHAR(255) NOT NULL DEFAULT 'Automated (Folder Watch)',
  updated_at         TIMESTAMP NOT NULL DEFAULT now(),
  updated_by         INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- Login for a share that needs its own user ID/password (folder-watch/
-- share-credentials.js). Both NULL = use the backend machine's own Windows
-- account. The password is AES-256-GCM ciphertext, never plain text, and is
-- never returned by the API.
ALTER TABLE folder_watch_config ADD COLUMN IF NOT EXISTS share_username      VARCHAR(255);
ALTER TABLE folder_watch_config ADD COLUMN IF NOT EXISTS share_password_enc  TEXT;

CREATE TABLE IF NOT EXISTS folder_watch_runs (
  id             SERIAL PRIMARY KEY,
  started_at     TIMESTAMP NOT NULL DEFAULT now(),
  finished_at    TIMESTAMP,
  status         VARCHAR(20) NOT NULL DEFAULT 'RUNNING',
  files_found    INTEGER NOT NULL DEFAULT 0,
  files_ingested INTEGER NOT NULL DEFAULT 0,
  files_skipped  INTEGER NOT NULL DEFAULT 0,
  files_failed   INTEGER NOT NULL DEFAULT 0,
  error_message  TEXT,
  -- NULL = the scheduler fired it; set = a person clicked "Run Now".
  triggered_by   INTEGER REFERENCES users(id) ON DELETE SET NULL
);

ALTER TABLE folder_watch_runs DROP CONSTRAINT IF EXISTS folder_watch_runs_status_chk;
ALTER TABLE folder_watch_runs ADD CONSTRAINT folder_watch_runs_status_chk
  CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED'));

CREATE INDEX IF NOT EXISTS folder_watch_runs_started_idx ON folder_watch_runs(started_at DESC);

-- At most one scan at a time. Two overlapping scans both see a new file as not
-- yet taken and both store it: the row-level dedupe reads before it inserts,
-- so it cannot stop them. A second scan's RUNNING row fails this index and
-- runScan refuses it before reading any file. A RUNNING row at startup is a
-- scan the server stopped in the middle of — closed first, so it can't block
-- every later scan (or this index's creation).
UPDATE folder_watch_runs
   SET status = 'FAILED', finished_at = COALESCE(finished_at, now()),
       error_message = COALESCE(error_message, 'Interrupted — the server stopped before this scan finished.')
 WHERE status = 'RUNNING';
CREATE UNIQUE INDEX IF NOT EXISTS folder_watch_runs_one_running
  ON folder_watch_runs(status) WHERE status = 'RUNNING';

-- The reconciliation that ran after this scan's uploads — the same plan the
-- manual Upload & Run screen runs (every IP, Diag, Cheque, Bank batch, then
-- the PayU / EaseBuzz / Card / UPI passes), one entry per step.
ALTER TABLE folder_watch_runs ADD COLUMN IF NOT EXISTS generate_summary JSONB;

CREATE TABLE IF NOT EXISTS folder_watch_run_files (
  id               SERIAL PRIMARY KEY,
  run_id           INTEGER NOT NULL REFERENCES folder_watch_runs(id) ON DELETE CASCADE,
  file_name        VARCHAR(255) NOT NULL,
  detected_type    VARCHAR(30),
  outcome          VARCHAR(30) NOT NULL,
  batch_id         INTEGER,
  rows_ingested    INTEGER,
  generate_summary JSONB,
  error_message    TEXT,
  created_at       TIMESTAMP NOT NULL DEFAULT now()
);

ALTER TABLE folder_watch_run_files DROP CONSTRAINT IF EXISTS folder_watch_run_files_outcome_chk;
ALTER TABLE folder_watch_run_files ADD CONSTRAINT folder_watch_run_files_outcome_chk
  CHECK (outcome IN ('INGESTED', 'SKIPPED_DUPLICATE', 'SKIPPED_UNRECOGNIZED', 'SKIPPED_NEEDS_REVIEW', 'SKIPPED_EMPTY', 'FAILED'));

-- "Already taken" lookup — a file name with a terminal non-FAILED outcome
-- anywhere in history is skipped on sight, before even reading its bytes.
CREATE INDEX IF NOT EXISTS folder_watch_run_files_name_idx ON folder_watch_run_files(file_name, outcome);
CREATE INDEX IF NOT EXISTS folder_watch_run_files_run_idx  ON folder_watch_run_files(run_id);

-- "Retry" on the settings screen sets this on every earlier row for a file
-- name, so the next scan takes the file again. History is kept, not deleted:
-- what happened before stays visible, it just no longer counts as "taken".
ALTER TABLE folder_watch_run_files ADD COLUMN IF NOT EXISTS superseded BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- Location + department filters (client mail AC-10, 2026-09-21)
--
-- Location is the upload batch's unit_name (the HIS report header, e.g.
-- "YASHODA HEALTHCARE SERVICES LIMITED, SECUNDERABAD"), matched against the
-- location master by name — see src/scope-filters.js. Every batch table had it
-- except the Card/UPI MIS one, whose parsers read the header but never stored it.
ALTER TABLE ucr_ip_upload_batches ADD COLUMN IF NOT EXISTS unit_name VARCHAR(255);

-- Department. IP and Card/UPI already carry it (their own table, mis_source),
-- and a cheque's collection_kind 'OP' is the diagnostics ledger. Diag/OP online
-- rows are the one mix: the diagnostics advances report and the doctor-fee
-- (OPD) register land in the same table, so the row builder stamps which
-- report each came from. 'DIAG' | 'OPD'; NULL = a legacy non-HIS upload,
-- which only shows under "All Departments".
ALTER TABLE diag_op_payment_records ADD COLUMN IF NOT EXISTS department VARCHAR(8);

-- ---------------------------------------------------------------------------
-- Go-Live switch (client mail items 8 & 15, 2026-09-21) — one shared gate for
-- two invariants: from the cutoff date, every clean match locks itself (not
-- just an auditor-approved one, see locked_at/locked_by below), and every
-- MIS/bank delete endpoint refuses outright (backend/src/go-live.js). Until
-- the switch is live, Generate behaves exactly as it does today — this keeps
-- today's "tweak a rule, rerun, see updated results" workflow intact right up
-- to go-live. One row, same single-row-config shape as folder_watch_config.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS go_live_config (
  id           SERIAL PRIMARY KEY,
  cutoff_date  DATE NOT NULL,
  active       BOOLEAN NOT NULL DEFAULT true,
  updated_at   TIMESTAMP NOT NULL DEFAULT now(),
  updated_by   INTEGER REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO go_live_config (cutoff_date)
  SELECT '2026-10-01' WHERE NOT EXISTS (SELECT 1 FROM go_live_config);

-- bank_statement_records has no lock columns yet — every other record table
-- (ip_payment_records/diag_op_payment_records/cheque_collection_records/
-- ucr_ip_records, above) already does. Needed so a bank row can be locked by
-- the go-live gate the same way (bulkUpdateBankMatchStatus, matched-rules.routes.js).
ALTER TABLE bank_statement_records ADD COLUMN IF NOT EXISTS locked_at TIMESTAMP;
ALTER TABLE bank_statement_records ADD COLUMN IF NOT EXISTS locked_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Per-user screen access (enhancement request 2026-09-21, items 4 & 5:
-- "give screen access to user or auditors... implement at URL level, don't
-- block at API level"). Exact same shape as user_locations above — Admin
-- sees every grantable screen by role (no explicit grant needed, checked in
-- the frontend guard the same way it already treats role='Admin' as
-- full-access for locations); rows here are only meaningful for an Auditor.
-- The valid screen_key values are backend/src/screen-catalogue.js, not a
-- CHECK constraint, so the catalogue can grow without a migration.
-- ---------------------------------------------------------------------------
--
-- Created inside a DO block so the one-time backfill runs ONLY when the table
-- is first created: every Auditor who already exists at that moment keeps
-- exactly the access they had before this feature (all 12 grantable screens —
-- nothing was per-user restricted then), so deploying changes nobody's menu
-- until an Admin restricts someone. Re-running schema.sql never re-grants, so
-- an Auditor an Admin later cuts back to zero screens stays at zero.
-- Keep the key list in step with backend/src/screen-catalogue.js.
DO $$
BEGIN
  IF to_regclass('public.user_screens') IS NULL THEN
    CREATE TABLE user_screens (
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      screen_key  VARCHAR(64) NOT NULL,
      granted_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      granted_at  TIMESTAMP NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, screen_key)
    );
    INSERT INTO user_screens (user_id, screen_key)
      SELECT u.id, k.key
        FROM users u
       CROSS JOIN unnest(ARRAY[
         'upload-run', 'mismatch-review', 'match-approvals', 'statements',
         'reconciliation-results', 'manage-rules', 'division-bank-accounts', 'how-to-use',
         'insurance-dashboard', 'insurance-upload', 'insurance-excel-export', 'insurance-history'
       ]) AS k(key)
       WHERE u.role = 'Auditor';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- HIS API sync (Master Data → API Config / API Field Mapping, and "Sync IP
-- Collection" on Upload & Run). The HIS SOAP service returns the same rows as
-- the ADVANCES_YH.RPT sheet of the "All Collections" workbook; the sync stores
-- them in ip_payment_records exactly as the file upload does.
--
-- api_configs is created inside a DO block so the IpCollection config and its
-- default mapping are seeded ONLY when the table is first created: an Admin who
-- later edits or deletes them is never overridden by a restart. The API key is
-- never seeded — it is entered on the API Config screen and stored AES-GCM
-- encrypted (auth_key_enc), the same scheme as the shared-folder password.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  cfg_id INTEGER;
BEGIN
  IF to_regclass('public.api_configs') IS NULL THEN
    CREATE TABLE api_configs (
      id              SERIAL PRIMARY KEY,
      name            VARCHAR(100) NOT NULL UNIQUE,
      description     TEXT,
      url             TEXT NOT NULL,
      soap_action     TEXT,
      soap_method     VARCHAR(100) NOT NULL,
      soap_namespace  TEXT NOT NULL DEFAULT 'http://tempuri.org/',
      auth_param      VARCHAR(100),
      auth_key_enc    TEXT,
      date_param      VARCHAR(100) NOT NULL,
      date_format     VARCHAR(20) NOT NULL DEFAULT 'dd/MM/yyyy',
      loc_param       VARCHAR(100) NOT NULL,
      response_root   VARCHAR(100),
      total_field     VARCHAR(100),
      target_table    VARCHAR(64) NOT NULL DEFAULT 'ip_payment_records',
      row_filter      JSONB NOT NULL DEFAULT '[]'::jsonb,
      timeout_ms      INTEGER NOT NULL DEFAULT 60000,
      tls_insecure    BOOLEAN NOT NULL DEFAULT false,
      active          BOOLEAN NOT NULL DEFAULT true,
      created_by      VARCHAR(255),
      created_at      TIMESTAMP NOT NULL DEFAULT now(),
      updated_by      VARCHAR(255),
      updated_at      TIMESTAMP NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS api_field_mappings (
      id              SERIAL PRIMARY KEY,
      api_config_id   INTEGER NOT NULL REFERENCES api_configs(id) ON DELETE CASCADE,
      db_column       VARCHAR(64) NOT NULL,
      source_field    VARCHAR(100),
      transform       VARCHAR(30) NOT NULL DEFAULT 'DIRECT',
      transform_arg   JSONB,
      condition       JSONB,
      sort_order      INTEGER NOT NULL DEFAULT 0,
      UNIQUE (api_config_id, db_column)
    );

    INSERT INTO api_configs (
      name, description, url, soap_action, soap_method, soap_namespace, auth_param,
      date_param, date_format, loc_param, response_root, total_field, target_table, row_filter, created_by
    ) VALUES (
      'IpCollection',
      'HIS IP collection (advances) for one unit and one day',
      'https://yhapi.yashodahospital.com:8021/Service.asmx?op=IpCollection',
      'http://tempuri.org/IpCollection', 'IpCollection', 'http://tempuri.org/', 'htuayek',
      'trandate', 'dd/MM/yyyy', 'loc', 'IPcollectionv', 'Total', 'ip_payment_records',
      '[{"field":"BILL_IND","op":"in","values":["D"]},
        {"field":"CNCL_IND","op":"in","values":["N"]},
        {"field":"TCD_CHQ_BANK","op":"in","values":["UPI","ONL","MANUALUPI"]}]'::jsonb,
      'system'
    ) RETURNING id INTO cfg_id;

    INSERT INTO api_field_mappings (api_config_id, db_column, source_field, transform, transform_arg, condition, sort_order) VALUES
      (cfg_id, 'receipt_number',   'BILL_SEQ',            'RECEIPT_MONTH_PREFIX', '{"dateField":"BILL_DT","dateFormat":"dd-MM-yyyy HH:mm:ss"}', NULL, 1),
      (cfg_id, 'receipt_date',     'BILL_DT',             'DATETIME', '{"format":"dd-MM-yyyy HH:mm:ss"}', NULL, 2),
      (cfg_id, 'yhno',             'PIN',                 'DIRECT', NULL, NULL, 3),
      (cfg_id, 'ip_no',            'ADM_NO',              'DIRECT', NULL, NULL, 4),
      (cfg_id, 'patient_name',     'NAME',                'TRIM_SPACES', NULL, NULL, 5),
      (cfg_id, 'transaction_id_1', 'TCD_ONLINE_TRANS_ID', 'DIRECT', NULL, '{"field":"TCD_CHQ_BANK","op":"notIn","values":["UPI"]}', 6),
      (cfg_id, 'transaction_id_2', 'UPI_CHECK_REFID',     'DIRECT', NULL, NULL, 7),
      (cfg_id, 'payment_mode',     'TCD_CHQ_BANK',        'LOOKUP', '{"map":{"UPI":"UPI","MANUALUPI":"ManualUPI","ONL":"Online"}}', NULL, 8),
      (cfg_id, 'pay_type',         'TCD_CHQ_BANK',        'LOOKUP', '{"map":{"UPI":"UPI","MANUALUPI":"MANUALUPI"}}', NULL, 9),
      (cfg_id, 'remarks',          'TCD_CHQ_BANK',        'LOOKUP', '{"map":{"UPI":"UPI"}}', NULL, 10),
      (cfg_id, 'payment_remarks',  'TCD_CHQ_BANK',        'LOOKUP', '{"map":{"UPI":"UPI PAYMENT INTEGRATION"}}', NULL, 11),
      (cfg_id, 'bill_amount',      'TR_CH_AMT',           'NUMBER', NULL, NULL, 12),
      (cfg_id, 'online_amount',    'TR_CH_AMT',           'NUMBER', NULL, NULL, 13),
      (cfg_id, 'user_id',          'BILL_USR',            'DIRECT', NULL, NULL, 14),
      (cfg_id, 'user_name',        'APP_USR_NAME',        'TRIM_SPACES', NULL, NULL, 15);
  END IF;
END $$;

-- Re-stated outside the DO block so a database where api_configs already
-- existed (but this table somehow did not) still gets it. No-op otherwise.
CREATE TABLE IF NOT EXISTS api_field_mappings (
  id              SERIAL PRIMARY KEY,
  api_config_id   INTEGER NOT NULL REFERENCES api_configs(id) ON DELETE CASCADE,
  db_column       VARCHAR(64) NOT NULL,
  source_field    VARCHAR(100),
  transform       VARCHAR(30) NOT NULL DEFAULT 'DIRECT',
  transform_arg   JSONB,
  condition       JSONB,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  UNIQUE (api_config_id, db_column)
);

-- One row per Sync press: history, "last synced", and the in-flight guard.
CREATE TABLE IF NOT EXISTS api_sync_runs (
  id              SERIAL PRIMARY KEY,
  api_config_id   INTEGER REFERENCES api_configs(id) ON DELETE SET NULL,
  api_name        VARCHAR(100),
  location_id     INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  unit_name       VARCHAR(64),
  trans_date      DATE NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'RUNNING', -- RUNNING | SUCCESS | NO_DATA | DUPLICATE | FAILED
  rows_received   INTEGER,
  rows_kept       INTEGER,
  rows_stored     INTEGER,
  rows_skipped    INTEGER,
  batch_id        INTEGER,
  error_message   TEXT,
  started_by      VARCHAR(255),
  started_at      TIMESTAMP NOT NULL DEFAULT now(),
  finished_at     TIMESTAMP
);

-- Two people pressing Sync for the same API/unit/day at once: the second is refused.
CREATE UNIQUE INDEX IF NOT EXISTS api_sync_runs_one_running
  ON api_sync_runs (api_config_id, location_id, trans_date) WHERE status = 'RUNNING';
CREATE INDEX IF NOT EXISTS api_sync_runs_started_at_idx ON api_sync_runs (started_at DESC);

-- The HIS service's `loc` code per unit. Seeded once (only while unset, and
-- only if no other location already holds the code) so an Admin's edit on the
-- Location Master screen sticks.
ALTER TABLE locations ADD COLUMN IF NOT EXISTS his_loc_code INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS locations_his_loc_code_key ON locations(his_loc_code) WHERE his_loc_code IS NOT NULL;
UPDATE locations l
   SET his_loc_code = v.code
  FROM (VALUES ('Secunderabad', 1), ('Somajiguda', 5), ('Malakpet', 3), ('Hitech City', 9)) AS v(name, code)
 WHERE l.name = v.name
   AND l.his_loc_code IS NULL
   AND NOT EXISTS (SELECT 1 FROM locations o WHERE o.his_loc_code = v.code);

-- Where an IP batch came from: an uploaded file, or an API sync run.
ALTER TABLE ip_payment_upload_batches ADD COLUMN IF NOT EXISTS source VARCHAR(10) NOT NULL DEFAULT 'FILE'; -- 'FILE' | 'API'
ALTER TABLE ip_payment_upload_batches ADD COLUMN IF NOT EXISTS api_sync_run_id INTEGER REFERENCES api_sync_runs(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- API sync into the other stores the IP report feeds (Card / UPI rows, cheque
-- collections, refunds), and ONE API batch per unit and month.
--
-- An API sync appends to its unit's batch for the month instead of creating a
-- batch per day (src/api-sync/stores.js): thirty daily syncs across four units
-- and four stores would otherwise be ~480 batches a month. `period_month` is
-- the first day of that month; file uploads leave it NULL. The unique indexes
-- are what make two syncs racing to open a new month share one batch. A batch
-- table that holds several kinds (IP / OP / DIAG) keeps one batch per kind.
--
-- The per-sync IP batches created before this (source = 'API', period_month
-- NULL) are untouched, and NULLs never collide in a unique index.
--
-- The refund document names its unit on every ROW (one workbook holds all
-- four), so its batch never needed one. An API batch is one unit's, so it does.
-- ---------------------------------------------------------------------------
ALTER TABLE ucr_ip_upload_batches            ADD COLUMN IF NOT EXISTS source VARCHAR(10) NOT NULL DEFAULT 'FILE'; -- 'FILE' | 'API'
ALTER TABLE cheque_collection_upload_batches ADD COLUMN IF NOT EXISTS source VARCHAR(10) NOT NULL DEFAULT 'FILE';
ALTER TABLE refund_upload_batches            ADD COLUMN IF NOT EXISTS source VARCHAR(10) NOT NULL DEFAULT 'FILE';
ALTER TABLE refund_upload_batches            ADD COLUMN IF NOT EXISTS unit_name VARCHAR(255);

ALTER TABLE ip_payment_upload_batches        ADD COLUMN IF NOT EXISTS period_month DATE;
ALTER TABLE ucr_ip_upload_batches            ADD COLUMN IF NOT EXISTS period_month DATE;
ALTER TABLE cheque_collection_upload_batches ADD COLUMN IF NOT EXISTS period_month DATE;
ALTER TABLE refund_upload_batches            ADD COLUMN IF NOT EXISTS period_month DATE;

CREATE UNIQUE INDEX IF NOT EXISTS ip_payment_upload_batches_api_month_key
  ON ip_payment_upload_batches (unit_name, period_month) WHERE source = 'API';
CREATE UNIQUE INDEX IF NOT EXISTS ucr_ip_upload_batches_api_month_key
  ON ucr_ip_upload_batches (unit_name, period_month, mis_source) WHERE source = 'API';
CREATE UNIQUE INDEX IF NOT EXISTS cheque_collection_upload_batches_api_month_key
  ON cheque_collection_upload_batches (unit_name, period_month, collection_kind) WHERE source = 'API';
CREATE UNIQUE INDEX IF NOT EXISTS refund_upload_batches_api_month_key
  ON refund_upload_batches (unit_name, period_month) WHERE source = 'API';

-- The same for the Diagnostics / OP MIS, which the DIAG API feeds.
ALTER TABLE diag_op_upload_batches ADD COLUMN IF NOT EXISTS source VARCHAR(10) NOT NULL DEFAULT 'FILE'; -- 'FILE' | 'API'
ALTER TABLE diag_op_upload_batches ADD COLUMN IF NOT EXISTS period_month DATE;
CREATE UNIQUE INDEX IF NOT EXISTS diag_op_upload_batches_api_month_key
  ON diag_op_upload_batches (unit_name, period_month) WHERE source = 'API';

-- The API Configs the app adds after its first start (src/api-sync/seed-configs.js),
-- by key: each is added ONCE, so one an Admin later edits, renames or deletes
-- is never put back by a restart.
CREATE TABLE IF NOT EXISTS api_config_seeds (
  seed_key   VARCHAR(100) PRIMARY KEY,
  seeded_at  TIMESTAMP NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Automatic daily pull from the HIS (src/api-sync/auto-pull.js).
--
-- Every morning the app asks the HIS for the day BEFORE — every active unit
-- with a HIS Loc Code, every API Config that is switched on — and stores it,
-- exactly as a person pressing "Sync from HIS" for each unit would. The bank
-- and gateway statements still arrive through the shared folder, whose own
-- daily check then reconciles (folder_watch_config above).
--
-- One settings row, the same shape as folder_watch_config. It ships switched
-- OFF: nothing calls the HIS on its own until an Admin turns it on.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_pull_schedule (
  id                SERIAL PRIMARY KEY,
  active            BOOLEAN NOT NULL DEFAULT false,
  -- Wall-clock IST, like folder_watch_config.run_time — never the server's own timezone.
  run_time          TIME NOT NULL DEFAULT '08:00:00',
  -- A day that was missed (server off, HIS down) is pulled on a later morning,
  -- this many days back at most. 0 = only ever the day before.
  catch_up_days     INTEGER NOT NULL DEFAULT 3,
  -- A pull that did not finish cleanly is tried again the same morning.
  retry_count       INTEGER NOT NULL DEFAULT 2,
  retry_minutes     INTEGER NOT NULL DEFAULT 15,
  uploaded_by_label VARCHAR(255) NOT NULL DEFAULT 'Automated (HIS pull)',
  -- The IST day it was last switched on. Catching up never reaches further
  -- back than the day before this: a day from before the pull was on was not
  -- "missed", and switching it on must not quietly load a week of old data.
  active_since      DATE,
  updated_at        TIMESTAMP NOT NULL DEFAULT now(),
  updated_by        INTEGER REFERENCES users(id) ON DELETE SET NULL
);
INSERT INTO api_pull_schedule (active)
SELECT false WHERE NOT EXISTS (SELECT 1 FROM api_pull_schedule);

-- One row per pull: the morning's scheduled one, each same-morning retry of
-- it, or an Admin's "Pull now". What each API did is in api_sync_runs as for
-- any sync; `summary` holds the outcome per unit and day so the settings
-- screen can show a pull at a glance.
CREATE TABLE IF NOT EXISTS api_pull_runs (
  id             SERIAL PRIMARY KEY,
  started_at     TIMESTAMP NOT NULL DEFAULT now(),
  finished_at    TIMESTAMP,
  -- RUNNING | COMPLETED (nothing left to pull) | PARTIAL (some pulled, some
  -- not) | FAILED (nothing could be pulled)
  status         VARCHAR(20) NOT NULL DEFAULT 'RUNNING',
  -- NULL = the schedule fired it; set = a person pressed "Pull now".
  triggered_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- 1 = the scheduled pull (or a Pull now); 2+ = a retry of that morning's.
  attempt        INTEGER NOT NULL DEFAULT 1,
  -- The collection days looked at: the day before the pull, and any earlier
  -- day being caught up.
  day_from       DATE NOT NULL,
  day_to         DATE NOT NULL,
  unit_days      INTEGER NOT NULL DEFAULT 0,
  rows_stored    INTEGER NOT NULL DEFAULT 0,
  apis_failed    INTEGER NOT NULL DEFAULT 0,
  summary        JSONB,
  error_message  TEXT
);
CREATE INDEX IF NOT EXISTS api_pull_runs_started_idx ON api_pull_runs(started_at DESC);

-- At most one pull at a time, and a RUNNING row at startup is a pull the
-- server stopped in the middle of — closed first, as for folder_watch_runs.
-- What it missed is picked up by the next morning's catch-up.
UPDATE api_pull_runs
   SET status = 'FAILED', finished_at = COALESCE(finished_at, now()),
       error_message = COALESCE(error_message, 'Interrupted — the server stopped before this pull finished.')
 WHERE status = 'RUNNING';
CREATE UNIQUE INDEX IF NOT EXISTS api_pull_runs_one_running
  ON api_pull_runs(status) WHERE status = 'RUNNING';
