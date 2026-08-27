# FRS - Recon Backend

Node.js (plain JavaScript) + PostgreSQL REST API for the insurance policy PDF
extraction module. Parses uploaded policy PDFs into structured, confidence-scored
data and persists it.

**No TypeScript, no build step, no ORM** — CommonJS, Express, raw `pg`.

## Setup

```bash
npm install
cp .env.example .env      # then fill in your PostgreSQL details
npm run init-db           # creates the database (if absent) + all tables
npm start                 # http://localhost:4000
```

`npm run init-db` is idempotent — safe to re-run. It creates the database named
in `PGDATABASE` if it doesn't exist (connecting via the `postgres` maintenance
database first), then applies `sql/schema.sql`, which is all
`CREATE TABLE IF NOT EXISTS`. `npm start` runs both steps automatically too.

### Environment variables

| Variable | Purpose |
|---|---|
| `PGHOST` / `PGPORT` / `PGDATABASE` / `PGUSER` / `PGPASSWORD` | PostgreSQL connection |
| `PGSSL` | `true` to enable SSL (managed/cloud Postgres) |
| `PGMAINTENANCE_DB` | Maintenance DB used only to `CREATE DATABASE` (default `postgres`) |
| `PG_POOL_MAX` | Connection pool size (default 10) |
| `PORT` / `HOST` | HTTP server bind (default `4000` / `0.0.0.0`) |
| `UPLOAD_DIR` | Where uploaded PDFs are stored (default `uploads/`) |

## API

Base path `/api`. All responses are camelCase JSON matching the Angular
frontend's `core/models/*.ts` interfaces.

### Documents
| Endpoint | Notes |
|---|---|
| `POST /api/documents/upload` | multipart, field `files` (up to 20 PDFs, 25 MB each) |
| `GET /api/documents` | newest first |
| `GET /api/documents/:id` | |
| `PATCH /api/documents/:id` | `{ status, errorMessage }` |
| `DELETE /api/documents/:id` | cascades to policy, members, and fields |

### Extraction
| Endpoint | Notes |
|---|---|
| `POST /api/documents/:id/extract` | Runs the parser and persists results. Re-runnable — replaces prior results for that document. Sets status to `Completed`, or `Needs Review` if any field came out low-confidence. |
| `GET /api/documents/:id/extraction` | `{ documentId, policy, fields, metadata }` |
| `PATCH /api/documents/:id/extraction/fields` | `{ path, value }` — writes through to the real column *and* marks that field verified / 100% confidence |
| `GET /api/documents/:id/validation` | `{ completenessPercent, checks, issues, isSaveBlocked }` |

### Members
| Endpoint | Notes |
|---|---|
| `POST /api/documents/:id/members` | |
| `PATCH /api/documents/:id/members/:memberId` | |
| `DELETE /api/documents/:id/members/:memberId` | |
| `POST /api/documents/:id/members/:memberId/duplicate` | appends `(Copy)` to the name |

All four re-index the `members.N.*` extraction field paths afterward so they
never point at a stale position.

### Policies
| Endpoint | Notes |
|---|---|
| `GET /api/policies` | members nested |
| `GET /api/policies/:id` | |
| `PATCH /api/policies/:id` | |
| `DELETE /api/policies/:id` | |
| `PATCH /api/policies/:id/excel-generated` | stamps `excelGeneratedAt` |

## How extraction works

Rule-based text parsing — **no AI/LLM API, no API key, no per-document cost**.

Real policy schedules are tables, so the label and its value come out of the
PDF as *separate* text items:

    POLICY NO.:
    0503022826P103977707

Everything therefore reads **positionally** (`src/extraction/lines.js`), not by
matching `Label: value` on one line.

Each insurer gets its own parser under `src/extraction/formats/`, chosen by a
signature match on the document text. Adding an insurer means adding one module
there — the routes, database layer, and Excel mapper stay untouched, because
every parser returns the same shape.

| Format | Status |
|---|---|
| `UNITED_INDIA_FAMILY_MEDICARE` | Verified cell-for-cell against the client's expected output |

An unrecognised layout returns HTTP 422 with a clear message and marks the
document Failed, rather than silently producing blank fields.

### Confidence

Confidence means "was this found in the document", not a probability — a
positional parser either locates a labelled value or it doesn't. Found = 97
(high), missing = 40 (low, so it surfaces in the validation centre). Values
fixed by business rule rather than read from the page (PLAN CHOSEN, the
Self/Parents code) are marked 100 and pre-verified, so reviewers aren't asked
to check something the document never contained.

Beyond per-field confidence there is a **reconciliation check**: the members'
base premiums must sum to Total Basic Premium. That catches a mis-parsed or
dropped member row, which no per-field score can see — each field on its own
still looks perfectly well-formed.

## Excel output

`GET /api/policies/export.xlsx[?ids=1,2]` streams the client's 29-column
workbook. Two rules taken from the supplied expected output:

1. One row per insured member.
2. Policy-level columns appear **only on the first member's row**; later rows
   leave them blank.

Generation lives here, server-side, so the layout has a single definition. The
Angular app renders a preview from the same rules and downloads the real file
from this endpoint.

### Two deliberate differences from the sample spreadsheet

Both are cases where the supplied sample lost information and this output
keeps it:

| Column | Sample | Here | Why |
|---|---|---|---|
| RECEIPT NUMBER | `10105030226134100000` | `10105030226134142467` | The number is 20 digits. Excel stored it as a float and truncated past 15 significant digits. Written as **text** here so it round-trips. |
| NOMINEE NAME | `Belide` | `Belide Arjun` | The name wraps onto two lines inside the PDF table cell; the sample captured only the first. |

Run `npm run verify` to see the full cell-by-cell comparison — those two are
the only differences, across all 29 columns and every member row.

## Verifying

```bash
npm run test-extraction        # parse the real policy, print every field + confidence
npm run verify                 # cell-by-cell diff against the client's expected output
npm start                      # then, in another shell:
npm run smoke-test             # full API round trip
```

## Known limits

- **One insurer format so far.** Other insurers need a parser module; the
  registry and the shared line helpers are the reusable part.
- **Text-based PDFs only.** A scanned schedule has no text layer and would need
  OCR.
- **`POLICY TYPE - SELF/PARENTS` is `"B"` when a member's relation to the
  policyholder is Mother, Father, or Parent, and `"A"` otherwise** — a rule
  given directly by the client, not derived from any sample output (no
  sample has ever included a parent row).
- **`POLICY RECEIPT DATE` mirrors the policy start date**, matching the expected
  output — *not* the "Receipt Date:" printed on the schedule (16/06/2026 for
  this policy). The printed date is still captured, as `printedReceiptDate`.
- **No authentication.** Anyone who can reach the port can call any endpoint.
