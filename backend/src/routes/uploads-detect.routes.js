/**
 * File-type detection for the consolidated upload screen. Mounted at
 * /api/uploads in server.js.
 *
 * READ-ONLY BY DESIGN: nothing here writes to the database, and nothing here
 * parses data rows. It answers one question — "what kind of file is this?" —
 * so the screen can show the user what it found and let them correct it before
 * anything is saved.
 *
 * Saving still happens through the existing, already-proven upload endpoints:
 * the client re-sends the file to `detected.endpoint` once the user confirms.
 * That keeps this feature entirely additive — no existing upload route,
 * parser or table is touched by it. The cost is uploading the bytes twice,
 * which for a ~7 MB weekly bundle is not worth trading statelessness for.
 */
const express = require('express');
const multer = require('multer');
const { detectFileType, SIGNATURES } = require('../online-upload/detect-file-type');

const router = express.Router();

const MAX_FILE_SIZE_BYTES = 70 * 1024 * 1024;
const MAX_FILES = 30;
const SPREADSHEET_MIMETYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES, files: MAX_FILES },
  fileFilter: (req, file, cb) => {
    const isSpreadsheet = SPREADSHEET_MIMETYPES.has(file.mimetype) || /\.(xlsx|xls)$/i.test(file.originalname);
    if (!isSpreadsheet) return cb(new Error('Only .xlsx/.xls files are accepted'));
    cb(null, true);
  },
});

/**
 * GET /api/uploads/types
 * The catalogue the screen needs to populate its "change type" dropdown —
 * every type this app can ingest, with the zone it belongs to. Static.
 */
router.get('/types', (req, res) => {
  res.json(
    SIGNATURES.map((s) => ({ type: s.type, label: s.label, zone: s.zone, endpoint: s.endpoint })),
  );
});

/**
 * POST /api/uploads/detect  (multipart field: `files`, up to 30)
 *
 * One entry per file, in the order sent. A file that can't even be opened gets
 * an `error` rather than sinking the whole batch — the user is usually dropping
 * a week's worth at once and shouldn't lose the good ones to one bad file.
 */
router.post('/detect', upload.array('files', MAX_FILES), async (req, res, next) => {
  try {
    const files = req.files || [];
    if (files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded (expected multipart field "files")' });
    }

    const results = files.map((file) => {
      const base = { fileName: file.originalname, fileSizeBytes: file.size };
      try {
        const { matches, sheetNames, certain } = detectFileType(file.buffer);
        return {
          ...base,
          certain,
          // Best match, or null when nothing recognised it. `certain` is false
          // in both the nothing-matched and several-matched cases, and the
          // screen asks the user in either.
          detected: matches[0] || null,
          alternatives: matches.slice(1),
          sheetNames,
        };
      } catch (err) {
        return { ...base, certain: false, detected: null, alternatives: [], sheetNames: [], error: err.message };
      }
    });

    res.json({ results });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
