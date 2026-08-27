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

const app = express();

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(uploadDir));

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api/documents', documentsRouter);
app.use('/api/documents', extractionRouter);
app.use('/api/policies', policiesRouter);
app.use('/api/online-upload', onlineUploadRouter);
app.use('/api/ip-payments', ipPaymentsRouter);
app.use('/api/diag-op-payments', diagOpPaymentsRouter);
app.use('/api/master', masterDataRouter);
app.use('/api/matched-rules', matchedRulesRouter);
app.use('/api/matching-rules', matchingRulesRouter);

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

  app.listen(PORT, HOST, () => {
    console.log(`FRS - Recon backend listening on http://${HOST}:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err.message);
  process.exit(1);
});

module.exports = app;
