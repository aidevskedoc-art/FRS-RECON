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
-- Master Rules: exception rules layered on top of the bank-statement <->
-- IP/Diag payment matching in reconciliation/matcher.js. Each rule is a
-- condition (field/operator/value) plus an action, applied in id order —
-- the first active rule whose condition matches a payment group wins. IP and
-- Diag rules are kept in separate tables, same convention as their payment
-- records already being separate tables rather than one shared, typed table.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ip_payment_matching_rules (
  id           SERIAL PRIMARY KEY,
  name         VARCHAR(255) NOT NULL,
  field        VARCHAR(32) NOT NULL,
  operator     VARCHAR(16) NOT NULL,
  value        VARCHAR(255) NOT NULL,
  action       VARCHAR(16) NOT NULL,
  active       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMP NOT NULL DEFAULT now(),
  updated_at   TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS diag_payment_matching_rules (
  id           SERIAL PRIMARY KEY,
  name         VARCHAR(255) NOT NULL,
  field        VARCHAR(32) NOT NULL,
  operator     VARCHAR(16) NOT NULL,
  value        VARCHAR(255) NOT NULL,
  action       VARCHAR(16) NOT NULL,
  active       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMP NOT NULL DEFAULT now(),
  updated_at   TIMESTAMP NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- System rows: the core matching engine's own parameters (amount tolerance,
-- split-payment grouping, which reference fields are checked), surfaced as
-- protected rows in the same table instead of hardcoded constants in
-- reconciliation/matcher.js — so they're visible and (for the safe ones)
-- editable from the same Manage Rules screen as the exception rules above.
-- is_system rows are seeded once, can't be created via the API, and can only
-- ever have their `value` column changed (see matching-rules.routes.js).
-- ---------------------------------------------------------------------------

ALTER TABLE ip_payment_matching_rules ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE diag_payment_matching_rules ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT false;

-- 'SET_SYSTEM_SETTING' (19 chars) exceeds the original VARCHAR(16) sized for
-- the exception-rule actions (FORCE_MATCHED/FORCE_UNMATCHED/EXCLUDE).
ALTER TABLE ip_payment_matching_rules ALTER COLUMN action TYPE VARCHAR(32);
ALTER TABLE diag_payment_matching_rules ALTER COLUMN action TYPE VARCHAR(32);

INSERT INTO ip_payment_matching_rules (name, field, operator, value, action, active, is_system)
SELECT 'Amount tolerance (₹)', 'amountTolerance', 'EQUALS', '1', 'SET_SYSTEM_SETTING', true, true
WHERE NOT EXISTS (SELECT 1 FROM ip_payment_matching_rules WHERE name = 'Amount tolerance (₹)');

INSERT INTO ip_payment_matching_rules (name, field, operator, value, action, active, is_system)
SELECT 'Split-payment grouping (same ref ending in a letter)', 'suffixGrouping', 'EQUALS', 'ENABLED', 'SET_SYSTEM_SETTING', true, true
WHERE NOT EXISTS (SELECT 1 FROM ip_payment_matching_rules WHERE name = 'Split-payment grouping (same ref ending in a letter)');

INSERT INTO ip_payment_matching_rules (name, field, operator, value, action, active, is_system)
SELECT 'Reference fields checked (in priority order)', 'referenceFields', 'EQUALS', 'transId, transactionRef1, transactionRef2', 'SET_SYSTEM_SETTING', true, true
WHERE NOT EXISTS (SELECT 1 FROM ip_payment_matching_rules WHERE name = 'Reference fields checked (in priority order)');

INSERT INTO diag_payment_matching_rules (name, field, operator, value, action, active, is_system)
SELECT 'Amount tolerance (₹)', 'amountTolerance', 'EQUALS', '1', 'SET_SYSTEM_SETTING', true, true
WHERE NOT EXISTS (SELECT 1 FROM diag_payment_matching_rules WHERE name = 'Amount tolerance (₹)');

INSERT INTO diag_payment_matching_rules (name, field, operator, value, action, active, is_system)
SELECT 'Split-payment grouping (same ref ending in a letter)', 'suffixGrouping', 'EQUALS', 'ENABLED', 'SET_SYSTEM_SETTING', true, true
WHERE NOT EXISTS (SELECT 1 FROM diag_payment_matching_rules WHERE name = 'Split-payment grouping (same ref ending in a letter)');

INSERT INTO diag_payment_matching_rules (name, field, operator, value, action, active, is_system)
SELECT 'Reference fields checked (in priority order)', 'referenceFields', 'EQUALS', 'transactionRef1, transactionRef2, transactionRef3', 'SET_SYSTEM_SETTING', true, true
WHERE NOT EXISTS (SELECT 1 FROM diag_payment_matching_rules WHERE name = 'Reference fields checked (in priority order)');

INSERT INTO ip_payment_matching_rules (name, field, operator, value, action, active, is_system)
SELECT 'Restrict matching to the same division', 'divisionScoping', 'EQUALS', 'ENABLED', 'SET_SYSTEM_SETTING', true, true
WHERE NOT EXISTS (SELECT 1 FROM ip_payment_matching_rules WHERE name = 'Restrict matching to the same division');

INSERT INTO diag_payment_matching_rules (name, field, operator, value, action, active, is_system)
SELECT 'Restrict matching to the same division', 'divisionScoping', 'EQUALS', 'ENABLED', 'SET_SYSTEM_SETTING', true, true
WHERE NOT EXISTS (SELECT 1 FROM diag_payment_matching_rules WHERE name = 'Restrict matching to the same division');

-- ---------------------------------------------------------------------------
-- Persisted match results: the Generate button (matched-rules.routes.js
-- POST .../generate) runs the reconciliation engine once and writes its
-- verdict onto every record it covers, instead of recomputing live on every
-- page view. NULL match_status means "never generated yet" for that record.
-- matched_at on the batch tables tells the batch-detail page whether to
-- require pressing Generate at all.
-- ---------------------------------------------------------------------------

ALTER TABLE ip_payment_upload_batches ADD COLUMN IF NOT EXISTS matched_at TIMESTAMP;
ALTER TABLE diag_op_upload_batches ADD COLUMN IF NOT EXISTS matched_at TIMESTAMP;

ALTER TABLE ip_payment_records ADD COLUMN IF NOT EXISTS match_status VARCHAR(20);
ALTER TABLE ip_payment_records ADD COLUMN IF NOT EXISTS match_applied_rule VARCHAR(255);
ALTER TABLE ip_payment_records ADD COLUMN IF NOT EXISTS match_amount_field VARCHAR(64);
ALTER TABLE ip_payment_records ADD COLUMN IF NOT EXISTS match_bank_record_id INTEGER REFERENCES bank_statement_records(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ip_payment_records_match_status_idx ON ip_payment_records(match_status);

ALTER TABLE diag_op_payment_records ADD COLUMN IF NOT EXISTS match_status VARCHAR(20);
ALTER TABLE diag_op_payment_records ADD COLUMN IF NOT EXISTS match_applied_rule VARCHAR(255);
ALTER TABLE diag_op_payment_records ADD COLUMN IF NOT EXISTS match_amount_field VARCHAR(64);
ALTER TABLE diag_op_payment_records ADD COLUMN IF NOT EXISTS match_bank_record_id INTEGER REFERENCES bank_statement_records(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS diag_op_payment_records_match_status_idx ON diag_op_payment_records(match_status);

-- match_applied_rule is reserved for a REAL exception rule's name (Force
-- Matched/Unmatched/Exclude, configured in Manage Rules) — never populated
-- with generated text, so the UI can trust it as "a rule you configured did
-- this." match_reason instead carries the core engine's own explanation
-- (reference used, tolerance, split-payment grouping) for the ordinary case
-- where no exception rule fired. TEXT, not VARCHAR: a split group's reason
-- lists every combined reference and can run long.
ALTER TABLE ip_payment_records ADD COLUMN IF NOT EXISTS match_reason TEXT;
ALTER TABLE diag_op_payment_records ADD COLUMN IF NOT EXISTS match_reason TEXT;

-- ---------------------------------------------------------------------------
-- Rule priority: explicit, user-configurable evaluation order for exception
-- rules (Manage Rules screen), instead of the implicit "creation order = id"
-- the engine used before. NULL for existing rows is backfilled to their id
-- (preserves current behavior exactly); new rows get one past the current
-- max on insert (see matching-rules.routes.js). System rows never use this —
-- they're always listed first via is_system DESC and never reordered.
-- ---------------------------------------------------------------------------

ALTER TABLE ip_payment_matching_rules ADD COLUMN IF NOT EXISTS sort_order INTEGER;
ALTER TABLE diag_payment_matching_rules ADD COLUMN IF NOT EXISTS sort_order INTEGER;

UPDATE ip_payment_matching_rules SET sort_order = id WHERE sort_order IS NULL;
UPDATE diag_payment_matching_rules SET sort_order = id WHERE sort_order IS NULL;

-- ---------------------------------------------------------------------------
-- Bank-side match tracking: mirrors the ip/diag *_records match_status
-- columns above, but on bank_statement_records instead — lets "Generate" be
-- run from the Bank Statement batch-detail page too, so a bank transaction
-- that no IP/Diag payment ever claimed can be identified and shown as
-- unmatched ("available only in the Bank Statement"), not just inferred.
-- match_payment_record_id deliberately has no FK: it points into either
-- ip_payment_records or diag_op_payment_records depending on
-- match_payment_type, and Postgres FKs can't target "one of two tables."
-- ---------------------------------------------------------------------------

ALTER TABLE bank_statement_records ADD COLUMN IF NOT EXISTS match_status VARCHAR(20);
ALTER TABLE bank_statement_records ADD COLUMN IF NOT EXISTS match_payment_type VARCHAR(16);
ALTER TABLE bank_statement_records ADD COLUMN IF NOT EXISTS match_payment_record_id INTEGER;
CREATE INDEX IF NOT EXISTS bank_statement_records_match_status_idx ON bank_statement_records(match_status);

ALTER TABLE bank_statement_uploads ADD COLUMN IF NOT EXISTS matched_at TIMESTAMP;

-- ---------------------------------------------------------------------------
-- Additional system rows: the matching mechanics that used to be hardcoded
-- constants in reconciliation/matcher.js (which bank fields are indexed,
-- which payment amount fields are checked, which bank column counts as "the"
-- amount, and how a multi-candidate tie is broken) — now surfaced the same
-- way as the original four system rows above. Every default value below
-- matches the prior hardcoded behavior exactly, so seeding these changes
-- nothing until an admin edits one from Manage Rules.
-- ---------------------------------------------------------------------------

INSERT INTO ip_payment_matching_rules (name, field, operator, value, action, active, is_system)
SELECT 'Bank fields checked', 'bankFields', 'EQUALS', 'chqRefNo, narration', 'SET_SYSTEM_SETTING', true, true
WHERE NOT EXISTS (SELECT 1 FROM ip_payment_matching_rules WHERE name = 'Bank fields checked');

INSERT INTO ip_payment_matching_rules (name, field, operator, value, action, active, is_system)
SELECT 'Amount fields checked', 'amountFields', 'EQUALS', 'billAmount, nonCashAmount', 'SET_SYSTEM_SETTING', true, true
WHERE NOT EXISTS (SELECT 1 FROM ip_payment_matching_rules WHERE name = 'Amount fields checked');

INSERT INTO ip_payment_matching_rules (name, field, operator, value, action, active, is_system)
SELECT 'Bank amount side', 'bankAmountSide', 'EQUALS', 'EITHER', 'SET_SYSTEM_SETTING', true, true
WHERE NOT EXISTS (SELECT 1 FROM ip_payment_matching_rules WHERE name = 'Bank amount side');

INSERT INTO ip_payment_matching_rules (name, field, operator, value, action, active, is_system)
SELECT 'Tie-break order', 'tieBreak', 'EQUALS', 'AMOUNT_FIRST', 'SET_SYSTEM_SETTING', true, true
WHERE NOT EXISTS (SELECT 1 FROM ip_payment_matching_rules WHERE name = 'Tie-break order');

INSERT INTO diag_payment_matching_rules (name, field, operator, value, action, active, is_system)
SELECT 'Bank fields checked', 'bankFields', 'EQUALS', 'chqRefNo, narration', 'SET_SYSTEM_SETTING', true, true
WHERE NOT EXISTS (SELECT 1 FROM diag_payment_matching_rules WHERE name = 'Bank fields checked');

INSERT INTO diag_payment_matching_rules (name, field, operator, value, action, active, is_system)
SELECT 'Amount fields checked', 'amountFields', 'EQUALS', 'billAmount, nonCashAmount', 'SET_SYSTEM_SETTING', true, true
WHERE NOT EXISTS (SELECT 1 FROM diag_payment_matching_rules WHERE name = 'Amount fields checked');

INSERT INTO diag_payment_matching_rules (name, field, operator, value, action, active, is_system)
SELECT 'Bank amount side', 'bankAmountSide', 'EQUALS', 'EITHER', 'SET_SYSTEM_SETTING', true, true
WHERE NOT EXISTS (SELECT 1 FROM diag_payment_matching_rules WHERE name = 'Bank amount side');

INSERT INTO diag_payment_matching_rules (name, field, operator, value, action, active, is_system)
SELECT 'Tie-break order', 'tieBreak', 'EQUALS', 'AMOUNT_FIRST', 'SET_SYSTEM_SETTING', true, true
WHERE NOT EXISTS (SELECT 1 FROM diag_payment_matching_rules WHERE name = 'Tie-break order');

-- ---------------------------------------------------------------------------
-- Unified rules list: settings and exception rules used to be two separate
-- concepts (protected, single-instance "system" rows vs. unlimited,
-- prioritized condition/action rows). They're now one list — every row can
-- optionally carry a condition (field/operator/value, now nullable: null
-- means "always applies") and/or a match-status output (action, now
-- nullable) and/or one or more matching-config overrides below. Multiple
-- rows can set the same config field; the highest-priority (lowest
-- sort_order) active row whose condition matches — or has none — wins for
-- that field, same first-match-wins evaluation the exception rules already
-- used. A field no row sets falls back to its original hardcoded default
-- (DEFAULT_AMOUNT_TOLERANCE etc. in reconciliation/matcher.js), so deleting
-- every row here is safe, not a broken state.
--
-- reference_fields and suffix_grouping affect how records are GROUPED,
-- before any group exists to evaluate a condition against — so those two
-- columns are only honored on a row with no condition (enforced in
-- matching-rules.routes.js), i.e. they stay effectively global.
-- ---------------------------------------------------------------------------

ALTER TABLE ip_payment_matching_rules ALTER COLUMN field DROP NOT NULL;
ALTER TABLE ip_payment_matching_rules ALTER COLUMN operator DROP NOT NULL;
ALTER TABLE ip_payment_matching_rules ALTER COLUMN value DROP NOT NULL;
ALTER TABLE ip_payment_matching_rules ALTER COLUMN action DROP NOT NULL;
ALTER TABLE diag_payment_matching_rules ALTER COLUMN field DROP NOT NULL;
ALTER TABLE diag_payment_matching_rules ALTER COLUMN operator DROP NOT NULL;
ALTER TABLE diag_payment_matching_rules ALTER COLUMN value DROP NOT NULL;
ALTER TABLE diag_payment_matching_rules ALTER COLUMN action DROP NOT NULL;

ALTER TABLE ip_payment_matching_rules ADD COLUMN IF NOT EXISTS amount_tolerance NUMERIC(10,2);
ALTER TABLE ip_payment_matching_rules ADD COLUMN IF NOT EXISTS reference_fields VARCHAR(255);
ALTER TABLE ip_payment_matching_rules ADD COLUMN IF NOT EXISTS suffix_grouping VARCHAR(20);
ALTER TABLE ip_payment_matching_rules ADD COLUMN IF NOT EXISTS division_scoping VARCHAR(20);
ALTER TABLE ip_payment_matching_rules ADD COLUMN IF NOT EXISTS bank_fields VARCHAR(255);
ALTER TABLE ip_payment_matching_rules ADD COLUMN IF NOT EXISTS amount_fields VARCHAR(255);
ALTER TABLE ip_payment_matching_rules ADD COLUMN IF NOT EXISTS bank_amount_side VARCHAR(20);
ALTER TABLE ip_payment_matching_rules ADD COLUMN IF NOT EXISTS tie_break VARCHAR(20);

ALTER TABLE diag_payment_matching_rules ADD COLUMN IF NOT EXISTS amount_tolerance NUMERIC(10,2);
ALTER TABLE diag_payment_matching_rules ADD COLUMN IF NOT EXISTS reference_fields VARCHAR(255);
ALTER TABLE diag_payment_matching_rules ADD COLUMN IF NOT EXISTS suffix_grouping VARCHAR(20);
ALTER TABLE diag_payment_matching_rules ADD COLUMN IF NOT EXISTS division_scoping VARCHAR(20);
ALTER TABLE diag_payment_matching_rules ADD COLUMN IF NOT EXISTS bank_fields VARCHAR(255);
ALTER TABLE diag_payment_matching_rules ADD COLUMN IF NOT EXISTS amount_fields VARCHAR(255);
ALTER TABLE diag_payment_matching_rules ADD COLUMN IF NOT EXISTS bank_amount_side VARCHAR(20);
ALTER TABLE diag_payment_matching_rules ADD COLUMN IF NOT EXISTS tie_break VARCHAR(20);

-- One-time data migration: fold each existing is_system row's field/value
-- into its matching new override column, clear the now-unneeded
-- condition/action columns, and drop its protected status — it's an
-- ordinary unconditional row from here on. Guarded by "override column still
-- NULL" so this only ever fires once per row, safe to run on every startup.
UPDATE ip_payment_matching_rules SET amount_tolerance = value::numeric, field = NULL, operator = NULL, value = NULL, action = NULL, is_system = false
  WHERE is_system = true AND field = 'amountTolerance' AND amount_tolerance IS NULL;
UPDATE ip_payment_matching_rules SET reference_fields = value, field = NULL, operator = NULL, value = NULL, action = NULL, is_system = false
  WHERE is_system = true AND field = 'referenceFields' AND reference_fields IS NULL;
UPDATE ip_payment_matching_rules SET suffix_grouping = value, field = NULL, operator = NULL, value = NULL, action = NULL, is_system = false
  WHERE is_system = true AND field = 'suffixGrouping' AND suffix_grouping IS NULL;
UPDATE ip_payment_matching_rules SET division_scoping = value, field = NULL, operator = NULL, value = NULL, action = NULL, is_system = false
  WHERE is_system = true AND field = 'divisionScoping' AND division_scoping IS NULL;
UPDATE ip_payment_matching_rules SET bank_fields = value, field = NULL, operator = NULL, value = NULL, action = NULL, is_system = false
  WHERE is_system = true AND field = 'bankFields' AND bank_fields IS NULL;
UPDATE ip_payment_matching_rules SET amount_fields = value, field = NULL, operator = NULL, value = NULL, action = NULL, is_system = false
  WHERE is_system = true AND field = 'amountFields' AND amount_fields IS NULL;
UPDATE ip_payment_matching_rules SET bank_amount_side = value, field = NULL, operator = NULL, value = NULL, action = NULL, is_system = false
  WHERE is_system = true AND field = 'bankAmountSide' AND bank_amount_side IS NULL;
UPDATE ip_payment_matching_rules SET tie_break = value, field = NULL, operator = NULL, value = NULL, action = NULL, is_system = false
  WHERE is_system = true AND field = 'tieBreak' AND tie_break IS NULL;

UPDATE diag_payment_matching_rules SET amount_tolerance = value::numeric, field = NULL, operator = NULL, value = NULL, action = NULL, is_system = false
  WHERE is_system = true AND field = 'amountTolerance' AND amount_tolerance IS NULL;
UPDATE diag_payment_matching_rules SET reference_fields = value, field = NULL, operator = NULL, value = NULL, action = NULL, is_system = false
  WHERE is_system = true AND field = 'referenceFields' AND reference_fields IS NULL;
UPDATE diag_payment_matching_rules SET suffix_grouping = value, field = NULL, operator = NULL, value = NULL, action = NULL, is_system = false
  WHERE is_system = true AND field = 'suffixGrouping' AND suffix_grouping IS NULL;
UPDATE diag_payment_matching_rules SET division_scoping = value, field = NULL, operator = NULL, value = NULL, action = NULL, is_system = false
  WHERE is_system = true AND field = 'divisionScoping' AND division_scoping IS NULL;
UPDATE diag_payment_matching_rules SET bank_fields = value, field = NULL, operator = NULL, value = NULL, action = NULL, is_system = false
  WHERE is_system = true AND field = 'bankFields' AND bank_fields IS NULL;
UPDATE diag_payment_matching_rules SET amount_fields = value, field = NULL, operator = NULL, value = NULL, action = NULL, is_system = false
  WHERE is_system = true AND field = 'amountFields' AND amount_fields IS NULL;
UPDATE diag_payment_matching_rules SET bank_amount_side = value, field = NULL, operator = NULL, value = NULL, action = NULL, is_system = false
  WHERE is_system = true AND field = 'bankAmountSide' AND bank_amount_side IS NULL;
UPDATE diag_payment_matching_rules SET tie_break = value, field = NULL, operator = NULL, value = NULL, action = NULL, is_system = false
  WHERE is_system = true AND field = 'tieBreak' AND tie_break IS NULL;
