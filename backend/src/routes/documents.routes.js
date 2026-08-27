const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('../db');
const { documentRowToApi } = require('../mappers');

const router = express.Router();

const uploadDir = path.join(__dirname, '..', '..', process.env.UPLOAD_DIR || 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}-${file.originalname}`),
});

/**
 * Per-request caps. The file count is the one clients hit in practice, so
 * it's exported: the Angular app splits a larger selection into batches of
 * this size rather than letting the request fail.
 */
const MAX_FILES_PER_UPLOAD = 20;
const MAX_FILE_SIZE_MB = 25;

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') {
      return cb(new Error('Only PDF files are accepted'));
    }
    cb(null, true);
  },
});

const uploadFiles = upload.array('files', MAX_FILES_PER_UPLOAD);

/**
 * Multer reports an over-limit batch as "Unexpected field", which reaches
 * the client as an opaque 500 and gives no hint that the file *count* was
 * the problem — and the whole batch is rejected, not just the excess. This
 * translates its errors into a 400 that names the actual limit, so a client
 * (or a person reading the response) can act on it.
 */
function handleUpload(req, res, next) {
  uploadFiles(req, res, (err) => {
    if (!err) return next();

    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({
        error: `Too many files in one request — the limit is ${MAX_FILES_PER_UPLOAD}. Upload them in smaller batches.`,
        code: 'TOO_MANY_FILES',
        maxFiles: MAX_FILES_PER_UPLOAD,
      });
    }
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        error: `That file is larger than the ${MAX_FILE_SIZE_MB} MB limit.`,
        code: 'FILE_TOO_LARGE',
        maxFileSizeMb: MAX_FILE_SIZE_MB,
      });
    }
    return res.status(400).json({ error: err.message });
  });
}

// POST /api/documents/upload
router.post('/upload', handleUpload, async (req, res, next) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded (expected multipart field "files")' });
    }

    const created = [];
    const duplicates = [];
    for (const file of req.files) {
      // Hashed by content, not name — the same PDF re-uploaded under a
      // different file name is still caught.
      const hash = crypto.createHash('sha256').update(fs.readFileSync(file.path)).digest('hex');

      const { rows: existing } = await db.query(
        'SELECT id, file_name, uploaded_at FROM documents WHERE file_hash = $1 LIMIT 1',
        [hash],
      );
      if (existing.length > 0) {
        fs.unlink(file.path, () => {});
        duplicates.push({
          fileName: file.originalname,
          existingDocumentId: String(existing[0].id),
          existingFileName: existing[0].file_name,
          existingUploadedAt: existing[0].uploaded_at,
        });
        continue;
      }

      const { rows } = await db.query(
        `INSERT INTO documents (file_name, file_size_bytes, file_path, status, file_hash)
         VALUES ($1, $2, $3, 'Uploaded', $4) RETURNING *`,
        [file.originalname, file.size, path.basename(file.path), hash],
      );
      created.push(documentRowToApi(rows[0]));
    }

    res.status(201).json({ documents: created, duplicates });
  } catch (err) {
    next(err);
  }
});

// GET /api/documents
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM documents ORDER BY uploaded_at DESC');
    res.json(rows.map(documentRowToApi));
  } catch (err) {
    next(err);
  }
});

// GET /api/documents/:id
router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM documents WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Document not found' });
    res.json(documentRowToApi(rows[0]));
  } catch (err) {
    next(err);
  }
});

// PATCH /api/documents/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const { status, errorMessage } = req.body;
    const { rows } = await db.query(
      `UPDATE documents SET
         status = COALESCE($2, status),
         error_message = $3
       WHERE id = $1 RETURNING *`,
      [req.params.id, status ?? null, errorMessage ?? null],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Document not found' });
    res.json(documentRowToApi(rows[0]));
  } catch (err) {
    next(err);
  }
});

// DELETE /api/documents/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const { rows } = await db.query('DELETE FROM documents WHERE id = $1 RETURNING file_path', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Document not found' });
    const filePath = path.join(uploadDir, rows[0].file_path);
    fs.unlink(filePath, () => {});
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = {
  router, uploadDir, MAX_FILES_PER_UPLOAD, MAX_FILE_SIZE_MB,
};
