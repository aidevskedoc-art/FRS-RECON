const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { documentRowToApi } = require('../mappers');

const router = express.Router();

const uploadDir = path.join(__dirname, '..', '..', process.env.UPLOAD_DIR || 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}-${file.originalname}`),
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') {
      return cb(new Error('Only PDF files are accepted'));
    }
    cb(null, true);
  },
});

// POST /api/documents/upload
router.post('/upload', upload.array('files', 20), async (req, res, next) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded (expected multipart field "files")' });
    }

    const created = [];
    for (const file of req.files) {
      const { rows } = await db.query(
        `INSERT INTO documents (file_name, file_size_bytes, file_path, status)
         VALUES ($1, $2, $3, 'Uploaded') RETURNING *`,
        [file.originalname, file.size, path.basename(file.path)],
      );
      created.push(documentRowToApi(rows[0]));
    }

    res.status(201).json(created);
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

module.exports = { router, uploadDir };
