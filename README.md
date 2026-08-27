# FRS - Recon

Upload an insurance policy PDF; the system extracts structured, confidence-scored
data from it, lets you review and correct that data, stores it in PostgreSQL, and
generates the client's 29-column Excel output with one row per insured member.

```
FRS/
├── frontend/   Angular 21 (standalone, PrimeNG + Tailwind + Bootstrap)
└── backend/    Node.js (plain JS) + Express + PostgreSQL
```

## Running it

Two terminals — the backend first, since the frontend proxies to it.

```bash
# terminal 1
cd backend
npm install
cp .env.example .env     # fill in your PostgreSQL details
npm start                # :4000 — creates the DB and tables on first run

# terminal 2
cd frontend
npm install
npm start                # :4200 — proxies /api and /uploads to :4000
```

Open the frontend, go to **Upload Documents**, drop in a policy PDF, and the
journey runs: upload → AI processing timeline → extraction workspace → validation
→ review → save → Excel preview → download.

There is **no mock data** — every screen reads from the database. A fresh install
shows an empty dashboard until you upload something.

## How the pieces fit

| Concern | Where |
|---|---|
| PDF text extraction, field rules, confidence scoring | `backend/src/extraction/` |
| Validation rules (single source of truth) | `backend/src/validation/validate.js` |
| REST API | `backend/src/routes/` |
| Schema | `backend/sql/schema.sql` |
| API-calling services | `frontend/src/app/core/services/` |
| Screens | `frontend/src/app/features/insurance-policy/` |
| Excel generation (client-side, SheetJS) | `frontend/src/app/core/services/excel.service.ts` |

Validation runs server-side only; the frontend renders whatever the API returns
rather than keeping a second copy of the rules that could drift.

Extraction is **rule-based text parsing — no AI/LLM API, no API key, no
per-document cost**. Real schedules are tables, so labels and values arrive as
separate text items and are read positionally; each insurer gets its own parser
module selected by a signature match. A field that isn't found scores low, which
flags the document as *Needs Review* and surfaces as a specific issue pointing at
that field. A reconciliation check (member base premiums must sum to Total Basic
Premium) catches a dropped or mis-parsed member row, which per-field confidence
cannot see. See `backend/README.md` for detail and known limits.

## Current state

Working end-to-end against the real client policy
(`inputs/` → `backend/test-fixtures/real-policy.pdf`), verified in a browser
and against a real PostgreSQL instance: upload → extraction → per-field editing
that persists → member add/edit/duplicate/remove → validation → save → Excel
preview → download.

The extractor's output is compared **cell by cell** against the client's
supplied expected-output spreadsheet by `cd backend && npm run verify`.
All 29 columns across every member row agree, apart from two places where the
sample itself lost information (a float-truncated receipt number and a
line-wrapped nominee name) — both documented in `backend/README.md`.

## Not yet addressed

- **No authentication.** Any client that can reach the API can call any
  endpoint. Needs solving before this is exposed beyond a trusted network.
- **One insurer layout.** Only United India "Family Medicare" schedules parse
  today. Other insurers need a parser module under
  `backend/src/extraction/formats/` — the registry, line helpers, database
  layer and Excel mapper are all shared, so it is one file per format.
- **Text-based PDFs only.** Scanned documents have no text layer and would
  need OCR.
- **Two columns are unexplained business rules**, taken from the expected
  output rather than derived: `POLICY TYPE - SELF/PARENTS` is always `"A"`,
  and `POLICY RECEIPT DATE` mirrors the policy start date rather than the
  receipt date printed on the schedule.
