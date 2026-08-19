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
