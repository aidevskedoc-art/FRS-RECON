/**
 * Detect + ingest for one file from the watched folder, and the end-of-scan
 * reconciliation plan. The point of this module is that it reuses the
 * existing upload and Generate routes completely unmodified, in-process,
 * rather than duplicating their parsing/dedupe/matching logic. Every route
 * handler here already operates on a plain (buffer, originalname, size) once
 * past multer, so a fake `req.file` reaches it exactly like a real multipart
 * upload would — same `findHandler()` technique the route test scripts use.
 *
 * Deciding WHAT to ingest follows the manual Upload & Run screen's own rules
 * (reconciliation.component.ts), not a stricter or looser invention:
 *   - A file can legitimately be several reports at once — the client's
 *     combined "All Collections" workbook is seven. Every matched report is
 *     a candidate, not just the best one.
 *   - A report with a dry-run preview (the HIS collection reports) is stored
 *     only if that preview is clean (his-preview.js previewIsClean — the same
 *     test the detect route uses for "nothing left for a person to decide").
 *     Anything else — unverified totals, held-back receipts, rows already
 *     stored, a sheet problem — is left for a person, with the reason.
 *   - A report without a preview is stored only when the detector is certain
 *     of it; an uncertain file waits for a person, same as on the screen.
 */
const { detectFileType, CONFIDENT } = require('../online-upload/detect-file-type');
const { attachHisPreviews, previewIsClean } = require('../online-upload/his-preview');
const db = require('../db');

const ipPaymentsRouter = require('../routes/ip-payments.routes');
const diagOpPaymentsRouter = require('../routes/diag-op-payments.routes');
const chequeCollectionsRouter = require('../routes/cheque-collections.routes');
const refundsRouter = require('../routes/refunds.routes');
const ucrUploadRouter = require('../routes/ucr-upload.routes');
const onlineUploadRouter = require('../routes/online-upload.routes');
const matchedRulesRouter = require('../routes/matched-rules.routes');
const ucrMatchedRouter = require('../routes/ucr-matched.routes');

function findHandler(router, method, routePath) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === routePath && l.route.methods[method.toLowerCase()],
  );
  if (!layer) throw new Error(`route ${method} ${routePath} not found`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

/** Invokes a route handler in-process, resolving/rejecting the way an HTTP round-trip would have. */
function invoke(handler, req) {
  return new Promise((resolve, reject) => {
    let statusCode = 200;
    const res = {
      status(code) { statusCode = code; return this; },
      json(payload) { resolve({ statusCode, body: payload }); return this; },
      send(payload) { resolve({ statusCode, body: payload }); return this; },
    };
    const next = (err) => reject(err);
    Promise.resolve(handler(req, res, next)).catch(reject);
  });
}

// Every ingestible type -> the router + path detect-file-type.js already
// points the manual screen at (the same endpoint strings as SIGNATURES'
// own `endpoint` field, resolved to an in-process handler instead of a URL).
const UPLOAD_HANDLERS = {
  MIS_IP: { router: ipPaymentsRouter, path: '/' },
  MIS_DIAG: { router: diagOpPaymentsRouter, path: '/' },
  CHEQUE_COLLECTION: { router: chequeCollectionsRouter, path: '/' },
  REFUND: { router: refundsRouter, path: '/' },
  UCR_IP: { router: ucrUploadRouter, path: '/ucr-ip' },
  UCR_OP: { router: ucrUploadRouter, path: '/ucr-op' },
  UCR_DIAG: { router: ucrUploadRouter, path: '/ucr-diag' },
  CARD_MPR: { router: ucrUploadRouter, path: '/card-mpr' },
  CARD_PINELABS: { router: ucrUploadRouter, path: '/card-pinelabs' },
  UPI_MPR: { router: ucrUploadRouter, path: '/upi-mpr' },
  BANK_STATEMENT: { router: onlineUploadRouter, path: '/bank-statement' },
  PAYU_MPR: { router: onlineUploadRouter, path: '/payu-mpr' },
  EASEBUZZ: { router: onlineUploadRouter, path: '/easebuzz' },
  EASEBUZZ_SETTLEMENT: { router: onlineUploadRouter, path: '/easebuzz-settlement' },
};

/** A single upload response can be one batch or several (a multi-sheet workbook) — normalise to [{id, rowCount}]. */
function extractBatches(body) {
  if (!body) return [];
  if (Array.isArray(body.batches)) return body.batches.map((b) => ({ id: b.id, rowCount: b.rowCount ?? null }));
  if (body.id) return [{ id: body.id, rowCount: body.rowCount ?? null }];
  return [];
}

/**
 * Why a dry-run preview leaves this report for a person — the same checks as
 * previewIsClean, turned into words. Returns { outcome, message }: a report
 * whose rows are ALL already stored is a duplicate, not a review item.
 */
function previewSkip(p) {
  if (p.status === 'FAILED') {
    return { outcome: 'SKIPPED_NEEDS_REVIEW', message: `Could not be read safely: ${(p.notes || []).join(' ') || 'no detail'}` };
  }
  if (p.ingest.rows === 0 && p.alreadyStored?.rows) {
    return { outcome: 'SKIPPED_DUPLICATE', message: 'Every row in this report is already stored from an earlier upload.' };
  }
  if (p.ingest.rows === 0) {
    // The manual screen silently unticks these — nothing for a person to do.
    return { outcome: 'SKIPPED_EMPTY', message: 'This report holds nothing to store.' };
  }
  if (p.overlap?.rows && p.overlap.rows >= p.ingest.rows) {
    // Every row is already stored — the same report arriving again (e.g. a
    // file taken again after Retry) is a duplicate, not something to review.
    return { outcome: 'SKIPPED_DUPLICATE', message: 'Every row in this report is already stored from an earlier upload.' };
  }
  if (p.overlap?.rows) {
    return { outcome: 'SKIPPED_NEEDS_REVIEW', message: `${p.overlap.rows} of its rows are already stored from an earlier upload — upload it from the manual screen to decide.` };
  }
  if (p.status === 'UNVERIFIED') {
    return { outcome: 'SKIPPED_NEEDS_REVIEW', message: 'Its totals could not be checked against the report’s own printed totals — a person needs to confirm it.' };
  }
  if (p.heldBack?.length) {
    return { outcome: 'SKIPPED_NEEDS_REVIEW', message: `${p.heldBack.length} receipt(s) would be held back for review — a person needs to confirm it.` };
  }
  const problems = (p.sheets || []).flatMap((s) => s.problems.map((pr) => `${s.sheetName}: ${pr.message}`));
  return { outcome: 'SKIPPED_NEEDS_REVIEW', message: problems.length ? problems.join(' | ') : 'Needs a person to review it.' };
}

async function uploadOne(buffer, fileName, type, uploadedByLabel) {
  const target = UPLOAD_HANDLERS[type];
  if (!target) {
    return { type, outcome: 'SKIPPED_NEEDS_REVIEW', batches: [], message: 'This report type has no automated ingestion path.' };
  }
  const req = {
    file: { buffer, originalname: fileName, size: buffer.length, mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    body: { uploadedBy: uploadedByLabel },
    query: {},
    headers: {},
  };
  try {
    const result = await invoke(findHandler(target.router, 'post', target.path), req);
    if (result.statusCode === 409) return { type, outcome: 'SKIPPED_DUPLICATE', batches: [], message: result.body?.error };
    if (result.statusCode >= 400) {
      return { type, outcome: 'FAILED', batches: [], message: result.body?.error || `Upload failed with status ${result.statusCode}` };
    }
    return { type, outcome: 'INGESTED', batches: extractBatches(result.body), message: null };
  } catch (err) {
    if (err.status === 409) return { type, outcome: 'SKIPPED_DUPLICATE', batches: [], message: err.message };
    // One report failing must not stop the other reports in the same workbook.
    return { type, outcome: 'FAILED', batches: [], message: err.message };
  }
}

/**
 * Detects and ingests one file. Returns one result per report found in it —
 * several for a combined workbook. Never throws for an ordinary outcome
 * (unrecognised, duplicate, needs a person); a per-report failure is
 * returned as FAILED for that report only.
 *
 * @returns {Promise<Array<{ type: string|null, outcome: string, batches: {id,rowCount}[], message: string|null }>>}
 */
async function ingestOneFile(buffer, fileName, uploadedByLabel) {
  const { matches, certain } = detectFileType(buffer);
  if (matches.length === 0) {
    return [{ type: null, outcome: 'SKIPPED_UNRECOGNIZED', batches: [], message: 'No known file type matched this file.' }];
  }

  const withPreviews = await attachHisPreviews(buffer, matches);
  const hasPreview = withPreviews.some((m) => m.preview);

  if (!hasPreview) {
    // An ordinary single-report file: stored only when the detector is sure.
    if (!certain) {
      const labels = matches.map((m) => m.label).join(', ');
      return [{
        type: matches[0].type,
        outcome: 'SKIPPED_NEEDS_REVIEW',
        batches: [],
        message: `Not certain which report this is (${labels}) — upload it from the manual screen to choose.`,
      }];
    }
    return [await uploadOne(buffer, fileName, matches[0].type, uploadedByLabel)];
  }

  // A HIS workbook: every report in it is decided on its own dry run.
  const results = [];
  for (const m of withPreviews) {
    if (m.preview) {
      if (previewIsClean(m.preview)) {
        results.push(await uploadOne(buffer, fileName, m.type, uploadedByLabel));
      } else {
        results.push({ type: m.type, batches: [], ...previewSkip(m.preview) });
      }
    } else if (m.confidence >= CONFIDENT) {
      results.push(await uploadOne(buffer, fileName, m.type, uploadedByLabel));
    } else {
      results.push({ type: m.type, outcome: 'SKIPPED_NEEDS_REVIEW', batches: [], message: `Only a weak match for ${m.label}.` });
    }
  }
  return results;
}

/**
 * The reconciliation the manual Upload & Run screen runs after its uploads
 * (reconciliation-run.service.ts planRun, "run everything"): every IP, Diag,
 * Cheque, then Bank Statement batch, in that order — payment side first so
 * every receipt carries a verdict, then which bank rows were claimed — then
 * the four global passes. Mirrored exactly so an automated run and a manual
 * run leave the data in the same state. One failed step is recorded and the
 * rest still run, same as the screen.
 *
 * @returns {Promise<Array<{ step: string, batchId?: string, counts?: object, error?: string }>>}
 */
async function buildPlanSteps() {
  const [ip, diag, cheque, bank] = await Promise.all([
    db.query('SELECT id FROM ip_payment_upload_batches ORDER BY id'),
    db.query('SELECT id FROM diag_op_upload_batches ORDER BY id'),
    db.query('SELECT id FROM cheque_collection_upload_batches ORDER BY id'),
    // PayU MPR and EaseBuzz rows share bank_statement_uploads and the same
    // per-batch Generate; leaving them out kept them "Not generated" forever.
    db.query(`SELECT id, source FROM bank_statement_uploads WHERE source IN ('BANK', 'PAYU_MPR', 'EASEBUZZ') ORDER BY id`),
  ]);
  const bankStep = { BANK: 'Bank Statements', PAYU_MPR: 'PayU MPR', EASEBUZZ: 'EaseBuzz' };

  return [
    ...ip.rows.map((b) => ({ step: 'IP Payments', router: matchedRulesRouter, path: '/ip-payments/generate', batchId: String(b.id) })),
    ...diag.rows.map((b) => ({ step: 'Diagnostics / OP Payments', router: matchedRulesRouter, path: '/diag-op-payments/generate', batchId: String(b.id) })),
    ...cheque.rows.map((b) => ({ step: 'Cheque Collections', router: matchedRulesRouter, path: '/cheque-collections/generate', batchId: String(b.id) })),
    ...bank.rows.map((b) => ({ step: bankStep[b.source], router: matchedRulesRouter, path: '/bank-statements/generate', batchId: String(b.id) })),
    { step: 'PayU settlements', router: matchedRulesRouter, path: '/payu-settlements/generate' },
    { step: 'EaseBuzz settlements', router: matchedRulesRouter, path: '/easebuzz-settlements/generate' },
    { step: 'Card reconciliation', router: ucrMatchedRouter, path: '/card-recon/generate' },
    { step: 'UPI reconciliation', router: ucrMatchedRouter, path: '/upi-recon/generate' },
  ];
}

async function runReconciliationPlan() {
  const steps = await buildPlanSteps();
  const summary = [];
  for (const s of steps) {
    const entry = { step: s.step, ...(s.batchId ? { batchId: s.batchId } : {}) };
    try {
      const req = { query: s.batchId ? { batchId: s.batchId } : {}, body: {}, headers: {} };
      const result = await invoke(findHandler(s.router, 'post', s.path), req);
      if (result.statusCode >= 400) entry.error = result.body?.error || `status ${result.statusCode}`;
      else entry.counts = result.body?.counts ?? null;
    } catch (err) {
      entry.error = err.message;
    }
    summary.push(entry);
  }
  return summary;
}

module.exports = { ingestOneFile, runReconciliationPlan, buildPlanSteps, UPLOAD_HANDLERS };
