const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { uploadDir } = require('./documents.routes');
const { extractPages } = require('../extraction/pdf-text');
const { parseByFormat } = require('../extraction/formats');
const { extractWithAi } = require('../extraction/ai-extraction');
const { toExtractionResult } = require('../extraction/to-extraction-result');
const { validate } = require('../validation/validate');
const {
  documentRowToApi,
  extractionMetadataRowToApi,
  policyRowToApi,
  fieldRowToApi,
} = require('../mappers');

const router = express.Router();

const POLICY_PATH_COLUMNS = {
  'policyHolder.name': 'policyholder_name',
  'policyHolder.address': 'policyholder_address',
  'policyHolder.customerId': 'customer_id',
  insuranceCompany: 'insurance_company',
  insuranceCompanyAddress: 'insurance_company_address',
  policyNumber: 'policy_number',
  policyStartDate: 'policy_start_date',
  policyEndDate: 'policy_end_date',
  policyTenureDays: 'policy_tenure_days',
  policyReceiptDate: 'policy_receipt_date',
  receiptNumber: 'receipt_number',
  planChosen: 'plan_chosen',
  policyType: 'policy_type',
  newOrRenewal: 'new_or_renewal',
  'premium.sumInsured': 'sum_insured',
  'premium.totalBasicPremium': 'total_basic_premium',
  'premium.familyFloaterDiscount': 'family_floater_discount',
  'premium.premium': 'premium',
  'premium.gst': 'gst',
  'premium.totalPremium': 'total_premium',
};

const MEMBER_FIELD_COLUMNS = {
  name: 'name',
  relationWithPolicyHolder: 'relation_with_policy_holder',
  age: 'age',
  gender: 'gender',
  occupation: 'occupation',
  basePremium: 'base_premium',
  policyTypeSelfParents: 'policy_type_self_parents',
  nomineeName: 'nominee_name',
  nomineeRelation: 'nominee_relation',
};

async function getPolicyIdForDocument(documentId) {
  const { rows } = await db.query('SELECT id FROM policies WHERE document_id = $1', [documentId]);
  return rows[0]?.id ?? null;
}

async function loadExtractionResult(documentId) {
  const { rows: docRows } = await db.query('SELECT * FROM documents WHERE id = $1', [documentId]);
  if (docRows.length === 0) return null;

  const { rows: policyRows } = await db.query('SELECT * FROM policies WHERE document_id = $1', [documentId]);
  if (policyRows.length === 0) return { document: docRows[0], policy: null, fields: [] };

  const { rows: memberRows } = await db.query(
    'SELECT * FROM insured_members WHERE policy_id = $1 ORDER BY sort_order',
    [policyRows[0].id],
  );
  const { rows: fieldRows } = await db.query(
    'SELECT * FROM extraction_fields WHERE document_id = $1 ORDER BY id',
    [documentId],
  );

  return {
    document: docRows[0],
    policy: policyRowToApi(policyRows[0], memberRows),
    fields: fieldRows.map(fieldRowToApi),
  };
}

/** Rebuilds every `members.*` extraction_fields row from the current insured_members — keeps paths in sync with indices after add/update/remove/duplicate. */
async function regenerateMemberFields(client, documentId, policyId) {
  await client.query("DELETE FROM extraction_fields WHERE document_id = $1 AND path LIKE 'members.%'", [documentId]);

  const { rows: members } = await client.query(
    'SELECT * FROM insured_members WHERE policy_id = $1 ORDER BY sort_order',
    [policyId],
  );

  for (let i = 0; i < members.length; i++) {
    const m = members[i];
    const entries = [
      ['name', m.name],
      ['relationWithPolicyHolder', m.relation_with_policy_holder],
      ['age', m.age],
      ['gender', m.gender],
      ['occupation', m.occupation],
      ['nomineeName', m.nominee_name],
      ['nomineeRelation', m.nominee_relation],
      ['basePremium', Number(m.base_premium)],
      ['policyTypeSelfParents', m.policy_type_self_parents],
    ];
    for (const [suffix, value] of entries) {
      await client.query(
        `INSERT INTO extraction_fields (document_id, path, label, value_text, confidence, confidence_score, source_page, verified)
         VALUES ($1, $2, $3, $4, 'high', 100, NULL, true)`,
        [documentId, `members.${i}.${suffix}`, `${m.name} — ${suffix}`, JSON.stringify(value)],
      );
    }
  }
}

/**
 * Shared by /extract and /ai-extract: turns a parser's output into the
 * stored policy/members/fields rows and the document's summary status.
 * Both routes only differ in how `parsed` was produced.
 */
async function persistExtraction(documentId, parsed, { pageTexts, startedAt }) {
  const { policy, fields, metadata } = toExtractionResult(parsed, {
    pagesAnalyzed: pageTexts.length,
    processingTimeMs: Date.now() - startedAt,
  });
  const processingTimeMs = metadata.processingTimeMs;

  const overallStatus = fields.some((f) => f.confidence === 'low') ? 'Needs Review' : 'Completed';

  await db.withTransaction(async (client) => {
    const { rows: existingPolicy } = await client.query('SELECT id FROM policies WHERE document_id = $1', [documentId]);

    const policyValues = [
      policy.policyHolder.name, policy.policyHolder.address, policy.policyHolder.customerId,
      policy.insuranceCompany, policy.insuranceCompanyAddress, policy.insuranceCompanyLegalName,
      policy.policyNumber, policy.previousPolicyNumber,
      policy.policyStartDate || null, policy.policyEndDate || null, policy.policyTenureDays || null,
      policy.policyReceiptDate || null, policy.printedReceiptDate || null,
      policy.receiptNumber, policy.planChosen, policy.policyType, policy.newOrRenewal,
      policy.premium.sumInsured, policy.premium.totalBasicPremium,
      policy.premium.familyFloaterDiscount, policy.premium.premium,
      policy.premium.gst, policy.premium.totalPremium,
      policy.tpaDetails ? policy.tpaDetails.tpaName : null,
      policy.sourceFormat,
    ];

    let policyId;
    if (existingPolicy.length > 0) {
      policyId = existingPolicy[0].id;
      await client.query(
        `UPDATE policies SET
           policyholder_name=$2, policyholder_address=$3, customer_id=$4,
           insurance_company=$5, insurance_company_address=$6, insurance_company_legal_name=$7,
           policy_number=$8, previous_policy_number=$9,
           policy_start_date=$10, policy_end_date=$11, policy_tenure_days=$12,
           policy_receipt_date=$13, printed_receipt_date=$14,
           receipt_number=$15, plan_chosen=$16, policy_type=$17, new_or_renewal=$18,
           sum_insured=$19, total_basic_premium=$20, family_floater_discount=$21,
           premium=$22, gst=$23, total_premium=$24, tpa_name=$25, source_format=$26,
           updated_at=now()
         WHERE id=$1`,
        [policyId, ...policyValues],
      );
      await client.query('DELETE FROM insured_members WHERE policy_id = $1', [policyId]);
    } else {
      const { rows } = await client.query(
        `INSERT INTO policies (
           document_id, policyholder_name, policyholder_address, customer_id,
           insurance_company, insurance_company_address, insurance_company_legal_name,
           policy_number, previous_policy_number,
           policy_start_date, policy_end_date, policy_tenure_days,
           policy_receipt_date, printed_receipt_date,
           receipt_number, plan_chosen, policy_type, new_or_renewal,
           sum_insured, total_basic_premium, family_floater_discount,
           premium, gst, total_premium, tpa_name, source_format
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
         RETURNING id`,
        [documentId, ...policyValues],
      );
      policyId = rows[0].id;
    }

    for (let i = 0; i < policy.members.length; i++) {
      const m = policy.members[i];
      await client.query(
        `INSERT INTO insured_members (
           policy_id, name, relation_with_policy_holder, age, gender, occupation,
           base_premium, policy_type_self_parents, nominee_name, nominee_relation,
           date_of_birth, inception_date, sort_order
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          policyId, m.name, m.relationWithPolicyHolder, m.age, m.gender, m.occupation,
          m.basePremium, m.policyTypeSelfParents, m.nomineeName, m.nomineeRelation,
          m.dateOfBirth || null, m.inceptionDate || null, i,
        ],
      );
    }

    await client.query('DELETE FROM extraction_fields WHERE document_id = $1', [documentId]);
    for (const f of fields) {
      await client.query(
        `INSERT INTO extraction_fields (document_id, path, label, value_text, confidence, confidence_score, source_page, verified)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [documentId, f.path, f.label, JSON.stringify(f.value), f.confidence, f.confidenceScore, f.sourcePage, f.verified],
      );
    }

    await client.query(
      `UPDATE documents SET
         status=$2, page_count=$3, pages_analyzed=$4, fields_extracted=$5, fields_total=$6,
         overall_confidence=$7, overall_confidence_score=$8, processing_time_ms=$9, extracted_at=now()
       WHERE id=$1`,
      [
        documentId, overallStatus, metadata.pagesAnalyzed, metadata.pagesAnalyzed,
        metadata.fieldsExtracted, metadata.fieldsTotal, metadata.overallConfidence,
        metadata.overallConfidenceScore, processingTimeMs,
      ],
    );
  });
}

const MEMBER_FLAT_FIELDS = [
  'name', 'relationWithPolicyHolder', 'age', 'gender', 'occupation',
  'basePremium', 'policyTypeSelfParents', 'nomineeName', 'nomineeRelation',
];

const isBlank = (v) => v === null || v === undefined || v === '';

/** Only ever *adds* values into fields that are currently blank — an already-filled field (parser-found or user-edited) is never touched, whatever the AI pass returned for it. */
function mergeMissing(current, ai) {
  const merged = { ...current };
  for (const key of Object.keys(current)) {
    if (key === 'members') continue;
    if (isBlank(current[key]) && !isBlank(ai[key])) merged[key] = ai[key];
  }
  merged.members = current.members.map((m, i) => {
    const aiMember = (ai.members || [])[i];
    if (!aiMember) return m;
    const mergedMember = { ...m };
    for (const key of MEMBER_FLAT_FIELDS) {
      if (isBlank(m[key]) && !isBlank(aiMember[key])) mergedMember[key] = aiMember[key];
    }
    return mergedMember;
  });
  return merged;
}

function hasAnyBlankField(parsed) {
  const topLevelBlank = Object.keys(parsed)
    .filter((k) => k !== 'members' && k !== 'format')
    .some((k) => isBlank(parsed[k]));
  if (topLevelBlank) return true;
  return (parsed.members || []).some((m) => MEMBER_FLAT_FIELDS.some((k) => isBlank(m[k])));
}

/**
 * Best-effort second pass folded into every /extract call: if the parser
 * (or a prior AI pass) left any field blank, try once to fill it via AI.
 * Deliberately swallows any AI failure (not configured, rate-limited,
 * network error, ...) rather than throwing — this is a bonus on top of a
 * parse that already succeeded, so a quota hiccup here should never turn
 * a working extraction into a failed request. The manual "Fill Missing
 * with AI" button remains the way to retry this specifically later.
 */
async function autoFillMissing(parsed, pageTexts) {
  if (!hasAnyBlankField(parsed)) return parsed;
  try {
    const ai = await extractWithAi({ pageTexts });
    return mergeMissing(parsed, ai);
  } catch {
    return parsed;
  }
}

// POST /api/documents/:id/extract
router.post('/:id/extract', async (req, res, next) => {
  try {
    const documentId = req.params.id;
    const { rows: docRows } = await db.query('SELECT * FROM documents WHERE id = $1', [documentId]);
    if (docRows.length === 0) return res.status(404).json({ error: 'Document not found' });
    const document = docRows[0];

    const startedAt = Date.now();
    const filePath = path.join(uploadDir, document.file_path);
    const buffer = fs.readFileSync(filePath);
    const { fullText, pageTexts } = await extractPages(buffer);

    let parsed;
    let usedAiFallback = false;
    try {
      parsed = parseByFormat({ fullText, pageTexts });
    } catch (parseErr) {
      if (parseErr.code !== 'UNKNOWN_FORMAT') throw parseErr;

      // No hand-written parser recognizes this insurer — try the AI
      // fallback automatically instead of failing outright. If AI isn't
      // configured or also fails, surface the original error unchanged.
      try {
        parsed = await extractWithAi({ pageTexts });
        usedAiFallback = true;
      } catch {
        await db.query('UPDATE documents SET status=$2, error_message=$3 WHERE id=$1', [
          documentId, 'Failed', parseErr.message,
        ]);
        return res.status(422).json({ error: parseErr.message, code: 'UNKNOWN_FORMAT' });
      }
    }

    // Whatever a parser found, top it up with one AI pass for anything
    // still blank — skipped when the AI fallback above already produced
    // this same `parsed` (no point asking the same model the same thing
    // twice in one request).
    if (!usedAiFallback) parsed = await autoFillMissing(parsed, pageTexts);

    await persistExtraction(documentId, parsed, { pageTexts, startedAt });

    const extraction = await loadExtractionResult(documentId);
    res.json({
      documentId: String(documentId),
      policy: extraction.policy,
      fields: extraction.fields,
      metadata: extractionMetadataRowToApi(extraction.document),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/documents/:id/ai-extract
 * Fallback for insurers with no hand-written parser: reads the same PDF
 * text a normal parser would, but has Gemini extract the fields instead
 * of matching a per-insurer layout. Opt-in — the frontend only offers
 * this after a normal /extract attempt has already failed with
 * UNKNOWN_FORMAT, since each call spends a real API request.
 */
router.post('/:id/ai-extract', async (req, res, next) => {
  try {
    const documentId = req.params.id;
    const { rows: docRows } = await db.query('SELECT * FROM documents WHERE id = $1', [documentId]);
    if (docRows.length === 0) return res.status(404).json({ error: 'Document not found' });
    const document = docRows[0];

    const startedAt = Date.now();
    const filePath = path.join(uploadDir, document.file_path);
    const buffer = fs.readFileSync(filePath);
    const { pageTexts } = await extractPages(buffer);

    let parsed;
    try {
      parsed = await extractWithAi({ pageTexts });
    } catch (aiErr) {
      if (aiErr.code === 'AI_NOT_CONFIGURED') {
        return res.status(503).json({ error: aiErr.message, code: aiErr.code });
      }
      if (aiErr.code === 'AI_BAD_RESPONSE') {
        return res.status(502).json({ error: aiErr.message, code: aiErr.code });
      }
      throw aiErr;
    }

    await persistExtraction(documentId, parsed, { pageTexts, startedAt });

    const extraction = await loadExtractionResult(documentId);
    res.json({
      documentId: String(documentId),
      policy: extraction.policy,
      fields: extraction.fields,
      metadata: extractionMetadataRowToApi(extraction.document),
    });
  } catch (err) {
    next(err);
  }
});

/** The `policies`/`insured_members` rows, reshaped back into the same flat "parsed" object every format parser (and extractWithAi) returns — so a fresh AI pass can be merged against what's already stored. */
function policyRowToParsed(row, memberRows) {
  const dateOnly = (v) => (v ? new Date(v).toISOString().slice(0, 10) : null);
  const num = (v) => (v === null || v === undefined ? null : Number(v));

  return {
    format: row.source_format,
    policyNumber: row.policy_number,
    previousPolicyNumber: row.previous_policy_number,
    newOrRenewal: row.new_or_renewal,
    insuranceCompany: row.insurance_company,
    insuranceCompanyLegalName: row.insurance_company_legal_name,
    insuranceCompanyAddress: row.insurance_company_address,
    policyholderName: row.policyholder_name,
    policyholderAddress: row.policyholder_address,
    customerId: row.customer_id,
    policyStartDate: dateOnly(row.policy_start_date),
    policyEndDate: dateOnly(row.policy_end_date),
    policyTenureDays: row.policy_tenure_days,
    policyReceiptDate: dateOnly(row.policy_receipt_date),
    printedReceiptDate: dateOnly(row.printed_receipt_date),
    receiptNumber: row.receipt_number === null ? null : String(row.receipt_number),
    policyType: row.policy_type,
    planChosen: row.plan_chosen,
    sumInsured: num(row.sum_insured),
    totalBasicPremium: num(row.total_basic_premium),
    familyFloaterDiscount: num(row.family_floater_discount),
    premium: num(row.premium),
    gst: num(row.gst),
    totalPremium: num(row.total_premium),
    tpaName: row.tpa_name,
    members: memberRows.map((m) => ({
      name: m.name,
      relationWithPolicyHolder: m.relation_with_policy_holder,
      age: m.age,
      gender: m.gender,
      occupation: m.occupation,
      basePremium: num(m.base_premium),
      policyTypeSelfParents: m.policy_type_self_parents,
      nomineeName: m.nominee_name,
      nomineeRelation: m.nominee_relation,
      dateOfBirth: dateOnly(m.date_of_birth),
      inceptionDate: dateOnly(m.inception_date),
    })),
  };
}

/**
 * POST /api/documents/:id/ai-fill-missing
 * For a document already extracted (by a parser or a prior AI pass), runs
 * a fresh AI read of the same PDF text and fills in only the fields that
 * are currently blank — every already-filled field (parser-found or
 * user-edited) is left exactly as it is. Meant for the Extraction
 * Workspace's "Fill Missing with AI" action, not the initial extraction.
 */
router.post('/:id/ai-fill-missing', async (req, res, next) => {
  try {
    const documentId = req.params.id;
    const { rows: docRows } = await db.query('SELECT * FROM documents WHERE id = $1', [documentId]);
    if (docRows.length === 0) return res.status(404).json({ error: 'Document not found' });
    const document = docRows[0];

    const { rows: policyRows } = await db.query('SELECT * FROM policies WHERE document_id = $1', [documentId]);
    if (policyRows.length === 0) {
      return res.status(404).json({ error: 'No extraction result for this document yet — run extraction first' });
    }
    const { rows: memberRows } = await db.query(
      'SELECT * FROM insured_members WHERE policy_id = $1 ORDER BY sort_order',
      [policyRows[0].id],
    );
    const current = policyRowToParsed(policyRows[0], memberRows);

    const startedAt = Date.now();
    const filePath = path.join(uploadDir, document.file_path);
    const buffer = fs.readFileSync(filePath);
    const { pageTexts } = await extractPages(buffer);

    let aiParsed;
    try {
      aiParsed = await extractWithAi({ pageTexts });
    } catch (aiErr) {
      if (aiErr.code === 'AI_NOT_CONFIGURED') return res.status(503).json({ error: aiErr.message, code: aiErr.code });
      if (aiErr.code === 'AI_BAD_RESPONSE') return res.status(502).json({ error: aiErr.message, code: aiErr.code });
      throw aiErr;
    }

    await persistExtraction(documentId, mergeMissing(current, aiParsed), { pageTexts, startedAt });

    const extraction = await loadExtractionResult(documentId);
    res.json({
      documentId: String(documentId),
      policy: extraction.policy,
      fields: extraction.fields,
      metadata: extractionMetadataRowToApi(extraction.document),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/documents/:id/extraction
router.get('/:id/extraction', async (req, res, next) => {
  try {
    const extraction = await loadExtractionResult(req.params.id);
    if (!extraction) return res.status(404).json({ error: 'Document not found' });
    if (!extraction.policy) return res.status(404).json({ error: 'No extraction result yet — call POST .../extract first' });

    res.json({
      documentId: String(req.params.id),
      policy: extraction.policy,
      fields: extraction.fields,
      metadata: extractionMetadataRowToApi(extraction.document),
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/documents/:id/extraction/fields  { path, value }
router.patch('/:id/extraction/fields', async (req, res, next) => {
  try {
    const documentId = req.params.id;
    const { path: fieldPath, value } = req.body;
    if (!fieldPath) return res.status(400).json({ error: '"path" is required' });

    const policyId = await getPolicyIdForDocument(documentId);
    if (!policyId) return res.status(404).json({ error: 'No extraction result for this document yet' });

    const memberMatch = fieldPath.match(/^members\.(\d+)\.(\w+)$/);
    if (memberMatch) {
      const [, indexStr, subfield] = memberMatch;
      const column = MEMBER_FIELD_COLUMNS[subfield];
      if (!column) return res.status(400).json({ error: `Unknown member field "${subfield}"` });

      const { rows: members } = await db.query(
        'SELECT id FROM insured_members WHERE policy_id = $1 ORDER BY sort_order',
        [policyId],
      );
      const member = members[Number(indexStr)];
      if (!member) return res.status(404).json({ error: 'Member index out of range' });

      await db.query(`UPDATE insured_members SET ${column} = $2 WHERE id = $1`, [member.id, value]);
    } else {
      const column = POLICY_PATH_COLUMNS[fieldPath];
      if (!column) return res.status(400).json({ error: `Unknown field path "${fieldPath}"` });
      await db.query(`UPDATE policies SET ${column} = $2, updated_at = now() WHERE id = $1`, [policyId, value]);
    }

    await db.query(
      `UPDATE extraction_fields SET value_text=$3, verified=true, confidence='high', confidence_score=100
       WHERE document_id=$1 AND path=$2`,
      [documentId, fieldPath, JSON.stringify(value)],
    );

    const extraction = await loadExtractionResult(documentId);
    res.json({ documentId: String(documentId), policy: extraction.policy, fields: extraction.fields });
  } catch (err) {
    next(err);
  }
});

// POST /api/documents/:id/members
router.post('/:id/members', async (req, res, next) => {
  try {
    const documentId = req.params.id;
    const policyId = await getPolicyIdForDocument(documentId);
    if (!policyId) return res.status(404).json({ error: 'No extraction result for this document yet' });

    const { rows: countRows } = await db.query('SELECT COUNT(*) FROM insured_members WHERE policy_id = $1', [policyId]);
    const nextOrder = Number(countRows[0].count);

    const { name, relationWithPolicyHolder, age, gender, occupation, basePremium, policyTypeSelfParents } = req.body;
    await db.query(
      `INSERT INTO insured_members (policy_id, name, relation_with_policy_holder, age, gender, occupation, base_premium, policy_type_self_parents, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [policyId, name, relationWithPolicyHolder, age, gender, occupation ?? null, basePremium ?? 0, policyTypeSelfParents, nextOrder],
    );

    await db.withTransaction((client) => regenerateMemberFields(client, documentId, policyId));
    const extraction = await loadExtractionResult(documentId);
    res.status(201).json(extraction.policy);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/documents/:id/members/:memberId
router.patch('/:id/members/:memberId', async (req, res, next) => {
  try {
    const documentId = req.params.id;
    const policyId = await getPolicyIdForDocument(documentId);
    if (!policyId) return res.status(404).json({ error: 'No extraction result for this document yet' });

    const patch = req.body;
    const setClauses = [];
    const values = [req.params.memberId];
    for (const [field, column] of Object.entries(MEMBER_FIELD_COLUMNS)) {
      if (patch[field] !== undefined) {
        values.push(patch[field]);
        setClauses.push(`${column} = $${values.length}`);
      }
    }
    if (setClauses.length > 0) {
      await db.query(`UPDATE insured_members SET ${setClauses.join(', ')} WHERE id = $1`, values);
    }

    await db.withTransaction((client) => regenerateMemberFields(client, documentId, policyId));
    const extraction = await loadExtractionResult(documentId);
    res.json(extraction.policy);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/documents/:id/members/:memberId
router.delete('/:id/members/:memberId', async (req, res, next) => {
  try {
    const documentId = req.params.id;
    const policyId = await getPolicyIdForDocument(documentId);
    if (!policyId) return res.status(404).json({ error: 'No extraction result for this document yet' });

    await db.query('DELETE FROM insured_members WHERE id = $1', [req.params.memberId]);
    await db.withTransaction((client) => regenerateMemberFields(client, documentId, policyId));
    const extraction = await loadExtractionResult(documentId);
    res.json(extraction.policy);
  } catch (err) {
    next(err);
  }
});

// POST /api/documents/:id/members/:memberId/duplicate
router.post('/:id/members/:memberId/duplicate', async (req, res, next) => {
  try {
    const documentId = req.params.id;
    const policyId = await getPolicyIdForDocument(documentId);
    if (!policyId) return res.status(404).json({ error: 'No extraction result for this document yet' });

    const { rows } = await db.query('SELECT * FROM insured_members WHERE id = $1', [req.params.memberId]);
    if (rows.length === 0) return res.status(404).json({ error: 'Member not found' });
    const source = rows[0];

    const { rows: countRows } = await db.query('SELECT COUNT(*) FROM insured_members WHERE policy_id = $1', [policyId]);
    const nextOrder = Number(countRows[0].count);

    await db.query(
      `INSERT INTO insured_members (policy_id, name, relation_with_policy_holder, age, gender, occupation, base_premium, policy_type_self_parents, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [policyId, `${source.name} (Copy)`, source.relation_with_policy_holder, source.age, source.gender, source.occupation, source.base_premium, source.policy_type_self_parents, nextOrder],
    );

    await db.withTransaction((client) => regenerateMemberFields(client, documentId, policyId));
    const extraction = await loadExtractionResult(documentId);
    res.status(201).json(extraction.policy);
  } catch (err) {
    next(err);
  }
});

// GET /api/documents/:id/validation
router.get('/:id/validation', async (req, res, next) => {
  try {
    const extraction = await loadExtractionResult(req.params.id);
    if (!extraction) return res.status(404).json({ error: 'Document not found' });
    if (!extraction.policy) return res.status(404).json({ error: 'No extraction result yet — call POST .../extract first' });

    const result = validate({ policy: extraction.policy, fields: extraction.fields });
    res.json({ documentId: String(req.params.id), ...result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
