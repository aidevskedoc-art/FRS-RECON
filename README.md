# Collection and Bank Deposit Reconciliation (CBDR)

Reconciles the hospital's collections — IP, Diagnostics, OP, cheques, refunds, card and UPI — against bank
statements and payment-gateway settlements (PayU, EaseBuzz), and shows every match, mismatch and pending
approval per unit.

```
FRS/
├── frontend/   Angular 21 (standalone, PrimeNG)
└── backend/    Node.js (plain JS) + Express + PostgreSQL
```

## Running it

Two terminals — the backend first, since the frontend proxies to it.

```bash
# terminal 1
cd backend
npm install
cp .env.example .env     # fill in your PostgreSQL details and JWT_SECRET
npm start                # :4000 — creates the DB and tables on first run

# terminal 2
cd frontend
npm install
npm start                # :4200 — proxies /api to :4000
```

## Where data comes from

- **Upload & Run** — drop any of the supported reports; the file type is detected, stored, and every
  reconciliation runs from one button.
- **Automation** (Admin) — the daily HIS pull for IP / Diagnostics / OP and the shared-folder check for
  statements, followed by an automatic reconciliation.

## Tests

```bash
cd backend
npm run test-unit        # matchers, parsers, rules
npm run test-api-sync    # HIS API mapping and the automatic pull
```

## History

Insurance policy PDF extraction was a module of this application until 6 October 2026. It is now its own
application (`D:\Work-load\Insurance-Policy`). Its four tables — `documents`, `policies`, `insured_members`,
`extraction_fields` — are no longer created here but are still in existing databases until dropped by hand.
