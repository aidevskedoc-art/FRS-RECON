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

-- Receipt numbers run to 20 digits — must stay text so no float rounding
-- can truncate them (the client's own spreadsheet lost the last 5 digits).
ALTER TABLE policies ALTER COLUMN receipt_number TYPE VARCHAR(64);

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
