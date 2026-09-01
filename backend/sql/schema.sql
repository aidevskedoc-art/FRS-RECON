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
-- Diag rules live in separate tables, same convention as their record tables.
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

-- Migrate an older rule table (config-layer era) to the shape above: widen
-- `action`, add the new columns, fold any legacy `conditions` JSON into
-- `condition_groups` (each old AND entry becomes its own single-leaf
-- OR-group), then drop every abandoned column. Guarded so this file stays
-- idempotent against a fresh DB and every prior version.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ip_payment_matching_rules', 'diag_payment_matching_rules'] LOOP
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
  FOREACH t IN ARRAY ARRAY['ip_payment_matching_rules', 'diag_payment_matching_rules'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS kind VARCHAR(32) NOT NULL DEFAULT ''CNF''', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS unit_config JSONB', t);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN condition_groups DROP NOT NULL', t);

    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', t, t || '_kind_chk');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (kind IN (''CNF'', ''UNIT_AGGREGATION''))', t, t || '_kind_chk');

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
         CHECK (kind <> ''UNIT_AGGREGATION'' OR unit_config IS NOT NULL)',
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

ALTER TABLE diag_op_payment_records ADD COLUMN IF NOT EXISTS match_status VARCHAR(20);
ALTER TABLE diag_op_payment_records ADD COLUMN IF NOT EXISTS match_applied_rule VARCHAR(255);
ALTER TABLE diag_op_payment_records ADD COLUMN IF NOT EXISTS match_amount_field VARCHAR(64);
ALTER TABLE diag_op_payment_records ADD COLUMN IF NOT EXISTS match_bank_record_id INTEGER REFERENCES bank_statement_records(id) ON DELETE SET NULL;
ALTER TABLE diag_op_payment_records ADD COLUMN IF NOT EXISTS match_reason TEXT;
CREATE INDEX IF NOT EXISTS diag_op_payment_records_match_status_idx ON diag_op_payment_records(match_status);

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
-- match_payment_type).
-- ---------------------------------------------------------------------------

ALTER TABLE bank_statement_records ADD COLUMN IF NOT EXISTS match_status VARCHAR(20);
ALTER TABLE bank_statement_records ADD COLUMN IF NOT EXISTS match_payment_type VARCHAR(16);
ALTER TABLE bank_statement_records ADD COLUMN IF NOT EXISTS match_payment_record_id INTEGER;
CREATE INDEX IF NOT EXISTS bank_statement_records_match_status_idx ON bank_statement_records(match_status);

ALTER TABLE bank_statement_uploads ADD COLUMN IF NOT EXISTS matched_at TIMESTAMP;
