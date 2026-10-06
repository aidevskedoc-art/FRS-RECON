require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');

const { router: documentsRouter, uploadDir } = require('./routes/documents.routes');
const extractionRouter = require('./routes/extraction.routes');
const policiesRouter = require('./routes/policies.routes');
const onlineUploadRouter = require('./routes/online-upload.routes');
const ipPaymentsRouter = require('./routes/ip-payments.routes');
const diagOpPaymentsRouter = require('./routes/diag-op-payments.routes');
const masterDataRouter = require('./routes/master-data.routes');
const matchedRulesRouter = require('./routes/matched-rules.routes');
const matchingRulesRouter = require('./routes/matching-rules.routes');
const chequeCollectionsRouter = require('./routes/cheque-collections.routes');
const refundsRouter = require('./routes/refunds.routes');
const ucrUploadRouter = require('./routes/ucr-upload.routes');
const ucrMatchedRouter = require('./routes/ucr-matched.routes');
const mismatchExportRouter = require('./routes/mismatch-export.routes');
const gatewayRulesRouter = require('./routes/gateway-rules.routes');
const uploadsDetectRouter = require('./routes/uploads-detect.routes');
const authRouter = require('./routes/auth.routes');
const { requireAuth, requireAuthExcept } = require('./middleware/auth');
const usersRouter = require('./routes/users.routes');
const auditLogsRouter = require('./routes/audit-logs.routes');
const matchApprovalsRouter = require('./routes/match-approvals.routes');
const folderWatchRouter = require('./routes/folder-watch.routes');
const { arm: armFolderWatchScheduler, armPullAtStartup } = require('./folder-watch/scheduler');
const { pauseWritesDuringScan, scanStatus } = require('./folder-watch/scan-lock');
const goLiveRouter = require('./routes/go-live.routes');
const apiConfigsRouter = require('./routes/api-configs.routes');
const apiSyncRouter = require('./routes/api-sync.routes');
const { seedApiConfigs } = require('./api-sync/seed-configs');

const app = express();

// CORS_ORIGIN unset (the default) keeps the API open to every origin, as
// before — only set it in .env to restrict which frontend origin(s) may call
// this API from a browser. Comma-separated so more than one dev port (or a
// deployed frontend alongside a staging one) can be allowed at once. A
// request with no Origin header (curl, server-to-server, Postman) is always
// allowed through — only browser cross-origin calls are ever restricted.
const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean)
  : null;

const corsOptions = allowedOrigins
  ? {
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
        callback(new Error(`Origin "${origin}" is not allowed by CORS_ORIGIN`));
      },
      credentials: true,
    }
  : undefined;

app.use(cors(corsOptions));
app.use(express.json());
// Uploaded insurance policy PDFs carry patient details — signed-in users only.
// The preview fetches them through the token-carrying HTTP client (an <iframe>
// can't send the Authorization header itself).
app.use('/uploads', requireAuth, express.static(uploadDir));

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Every /api route needs a signed-in user — secure by default, so a router
// added later is covered without remembering to. Only the health probe and
// the login itself are public. This is authentication (who you are), not the
// per-screen access (what you see), which stays at the URL level by design.
// CORS preflight never reaches here: the cors middleware above answers OPTIONS.
// The folder automation calls route handlers in-process, not over HTTP, so it
// is unaffected.
app.use('/api', requireAuthExcept(['/api/health', '/api/auth/login']));

// While the shared-folder scan runs (a few minutes a day), uploads, deletes and
// Generate are paused with a 423 so nobody races it; viewing is unaffected.
// See folder-watch/scan-lock.js. The status is what the frontend banner polls.
app.use('/api', pauseWritesDuringScan);
app.get('/api/scan-status', (req, res) => res.json(scanStatus()));

app.use('/api/documents', documentsRouter);
app.use('/api/documents', extractionRouter);
app.use('/api/policies', policiesRouter);
app.use('/api/online-upload', onlineUploadRouter);
app.use('/api/ip-payments', ipPaymentsRouter);
app.use('/api/diag-op-payments', diagOpPaymentsRouter);
app.use('/api/master', masterDataRouter);
app.use('/api/matched-rules', matchedRulesRouter);
app.use('/api/matching-rules', matchingRulesRouter);
app.use('/api/cheque-collections', chequeCollectionsRouter);
app.use('/api/refunds', refundsRouter);
app.use('/api/ucr-upload', ucrUploadRouter);
app.use('/api/ucr-matched', ucrMatchedRouter);
// Spans all four collection streams, so it is mounted at /api rather than under one of them.
app.use('/api', mismatchExportRouter);
// Matching policy for the four gateway/settlement matchers. Deliberately its own
// router rather than a fifth mountRuleCrud — see gateway-rules.routes.js.
app.use('/api/gateway-rules', gatewayRulesRouter);
app.use('/api/uploads', uploadsDetectRouter);
app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/audit-logs', auditLogsRouter);
app.use('/api/match-approvals', matchApprovalsRouter);
app.use('/api/folder-watch', folderWatchRouter);
app.use('/api/go-live', goLiveRouter);
// HIS API connections + field mapping (Master Data → API Config / API Field Mapping).
app.use('/api/api-configs', apiConfigsRouter);
// One unit-day from the HIS into every store an active API feeds (Upload & Run card).
app.use('/api/api-sync', apiSyncRouter);

app.use((req, res) => {
  res.status(404).json({ error: `No route for ${req.method} ${req.originalUrl}` });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

const PORT = Number(process.env.PORT) || 4000;
const HOST = process.env.HOST || '0.0.0.0';

async function start() {
  await db.ensureDatabase();
  await db.ensureSchema();
  console.log('Database schema ready.');

  // Inactive until an Admin checks and switches each on; a failure here must not stop the app.
  await seedApiConfigs()
    .then((names) => names.length && console.log(`[api-sync] added API config(s), inactive: ${names.join(', ')}`))
    .catch((err) => console.error('[api-sync] failed to add the seeded API configs:', err.message));

  await armFolderWatchScheduler().catch((err) => console.error('[folder-watch] failed to arm scheduler:', err.message));
  // The daily pull from the HIS — off until an Admin switches it on (Automation screen, HIS Data Pull tab).
  await armPullAtStartup().catch((err) => console.error('[his-pull] failed to arm scheduler:', err.message));

  app.listen(PORT, HOST, () => {
    console.log(`Collection and Bank Deposit Reconciliation backend listening on http://${HOST}:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err.message);
  process.exit(1);
});

module.exports = app;
