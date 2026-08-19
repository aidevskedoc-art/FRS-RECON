# Input files

Drop policy PDFs (and any expected-output spreadsheets) here.

The two files the extractor is currently built and verified against are copied
into `../backend/test-fixtures/`:

| File | Purpose |
|---|---|
| `real-policy.pdf` | United India "Family Medicare" schedule (BALLDE ARJUN, 30 pages) |
| `output-template.xlsx` | The client's expected 29-column output for that policy |

`npm run verify` in `../backend` compares the extractor's output against that
spreadsheet cell by cell.
