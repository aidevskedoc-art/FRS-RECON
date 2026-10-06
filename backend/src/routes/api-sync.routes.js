/**
 * "Sync from HIS" on Upload & Run: one unit, one day, into every store an
 * active API Config feeds (src/api-sync/sync-unit-day.js). Any signed-in user,
 * like the upload it stands in for; the API key is never in a response.
 */
const express = require('express');
const { uploaderOf } = require('../uploader');
const { syncUnitDay, syncOptions, resultToApi } = require('../api-sync/sync-unit-day');

const router = express.Router();

// GET /api/api-sync/options — the active APIs, the units they can be called for, recent runs.
router.get('/options', async (req, res, next) => {
  try {
    res.json(await syncOptions());
  } catch (err) {
    next(err);
  }
});

// POST /api/api-sync/run { locationId, date: 'YYYY-MM-DD', apiConfigIds? }
// Every active API (or only the ones named) for one unit-day. The answer is
// one result per API — a failed one is reported there, not as an HTTP error,
// because the others may have stored. A normal write, so it is paused (423)
// while the shared-folder scan runs.
router.post('/run', async (req, res, next) => {
  try {
    const { locationId, date, apiConfigIds } = req.body || {};
    if (apiConfigIds !== undefined) {
      const valid = Array.isArray(apiConfigIds) && apiConfigIds.length > 0 && apiConfigIds.every((id) => /^\d+$/.test(String(id)));
      if (!valid) return res.status(400).json({ error: 'apiConfigIds must be a list of API ids' });
    }
    const out = await syncUnitDay({ locationId, date, configIds: apiConfigIds, uploadedBy: uploaderOf(req), req });
    const results = out.results.map(resultToApi);
    res.status(results.some((r) => r.rowsStored > 0) ? 201 : 200).json({ ...out, results });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
