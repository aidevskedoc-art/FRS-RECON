/**
 * Fallback + top-up extractor. Two jobs:
 *
 *  1. Whole-document extraction for insurers with no hand-written parser
 *     under formats/ (called on UNKNOWN_FORMAT, and by the explicit
 *     "Try AI Extraction" action).
 *  2. Filling individual fields a parser left blank — autoFillMissing()
 *     in extraction.routes.js runs this on EVERY extract that has a gap,
 *     so this is not an opt-in path.
 *
 * Either way it hands the document's already-extracted text (see
 * pdf-text.js) to Gemini and asks for the same field shape every format
 * parser returns, via a JSON schema so the model can't drift from it.
 *
 * Returns { parsed, diagnostics } — diagnostics is what the Extraction
 * Workspace's AI report panel renders, and is the only way to tell
 * "the model found nothing" apart from "the model was never called".
 */

const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai');
const { policyTypeSelfParentsCode } = require('./formats/common');

// gemini-3.6-flash's free tier caps out at 20 requests/day — easy to burn
// through while testing. flash-lite trades a little capability for a much
// larger free quota and is still accurate enough for structured extraction
// (verified against hand-checked parser output before switching to it).
const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';

// Below this much recovered text the PDF is a scan, not a document, and a
// text-only model has nothing to read. Real single-page schedules run to
// thousands of characters, so this only catches genuinely empty layers.
const MIN_TEXT_CHARS = 50;

// A PDF sent for visual reading is inlined as base64 in the request body.
// The API caps a whole inline request at roughly 20MB, and base64 inflates
// bytes by a third, so refuse anything that would not fit rather than
// letting the API reject the call with a less obvious error.
const MAX_INLINE_PDF_BYTES = 14 * 1024 * 1024;

const MEMBER_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    name: { type: SchemaType.STRING, nullable: true },
    dateOfBirth: { type: SchemaType.STRING, nullable: true, description: 'ISO date YYYY-MM-DD' },
    age: { type: SchemaType.INTEGER, nullable: true },
    gender: { type: SchemaType.STRING, nullable: true, enum: ['Male', 'Female', 'Other'] },
    relationWithPolicyHolder: { type: SchemaType.STRING, nullable: true },
    occupation: { type: SchemaType.STRING, nullable: true },
    nomineeName: { type: SchemaType.STRING, nullable: true },
    nomineeRelation: { type: SchemaType.STRING, nullable: true },
    basePremium: { type: SchemaType.NUMBER, nullable: true },
  },
  required: [
    'name', 'dateOfBirth', 'age', 'gender', 'relationWithPolicyHolder',
    'occupation', 'nomineeName', 'nomineeRelation', 'basePremium',
  ],
};

const POLICY_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    policyNumber: { type: SchemaType.STRING, nullable: true },
    previousPolicyNumber: { type: SchemaType.STRING, nullable: true },
    newOrRenewal: { type: SchemaType.STRING, nullable: true, enum: ['New policy', 'Renewal policy'] },
    insuranceCompany: { type: SchemaType.STRING, nullable: true, description: 'Short brand name, e.g. "HDFC ERGO"' },
    insuranceCompanyLegalName: { type: SchemaType.STRING, nullable: true },
    insuranceCompanyAddress: { type: SchemaType.STRING, nullable: true },
    policyholderName: { type: SchemaType.STRING, nullable: true },
    policyholderAddress: { type: SchemaType.STRING, nullable: true },
    customerId: { type: SchemaType.STRING, nullable: true },
    policyStartDate: { type: SchemaType.STRING, nullable: true, description: 'ISO date YYYY-MM-DD' },
    policyEndDate: { type: SchemaType.STRING, nullable: true, description: 'ISO date YYYY-MM-DD' },
    receiptNumber: { type: SchemaType.STRING, nullable: true },
    printedReceiptDate: { type: SchemaType.STRING, nullable: true, description: 'ISO date YYYY-MM-DD' },
    policyType: { type: SchemaType.STRING, nullable: true, description: 'e.g. Individual, Family Floater' },
    sumInsured: { type: SchemaType.NUMBER, nullable: true },
    totalBasicPremium: { type: SchemaType.NUMBER, nullable: true },
    familyFloaterDiscount: { type: SchemaType.NUMBER, nullable: true },
    premium: { type: SchemaType.NUMBER, nullable: true, description: 'Net premium before tax' },
    gst: { type: SchemaType.NUMBER, nullable: true },
    totalPremium: { type: SchemaType.NUMBER, nullable: true },
    tpaName: { type: SchemaType.STRING, nullable: true },
    members: { type: SchemaType.ARRAY, items: MEMBER_SCHEMA },
  },
  required: [
    'policyNumber', 'previousPolicyNumber', 'newOrRenewal', 'insuranceCompany',
    'insuranceCompanyLegalName', 'insuranceCompanyAddress', 'policyholderName',
    'policyholderAddress', 'customerId', 'policyStartDate', 'policyEndDate',
    'receiptNumber', 'printedReceiptDate', 'policyType', 'sumInsured',
    'totalBasicPremium', 'familyFloaterDiscount', 'premium', 'gst', 'totalPremium',
    'tpaName', 'members',
  ],
};

const PROMPT_RULES = `Extract the fields defined by the response schema.

Rules:
- Only report a value you can actually find in the document. If a field isn't printed anywhere, return null for it — never guess or infer a value that isn't stated.
- Dates must be ISO format (YYYY-MM-DD), converted from whatever format the document uses.
- "members" is the list of insured persons on the policy (not the policyholder unless the policyholder is also listed as an insured member with their own age/DOB/relation).
- "premium" is the net premium before tax; "totalPremium" is the final amount after tax; "gst" is the tax component (sum CGST+SGST+IGST if shown separately).
- policyTypeSelfParents is intentionally omitted from what you extract — do not include it.
`;

const TEXT_PROMPT = `You are reading an Indian health insurance policy schedule extracted as plain text from a PDF. ${PROMPT_RULES}
Document text (each page marked, in reading order — table layouts may extract with cells out of visual order; use context and labels to resolve them):

`;

// Used when the PDF carries no text layer and the pages go to the model as
// images instead. Same field rules; the differences are all about reading
// off a scan rather than off extracted text.
const PDF_PROMPT = `You are reading a scanned Indian health insurance policy schedule. It is attached as a PDF whose pages are images — there is no text layer, so read the pages visually.

${PROMPT_RULES}
- Read values as printed on the page, including inside table cells. Keep each table row's values with that row's insured person; do not carry a value across rows.
- Where print or scan quality makes a character genuinely ambiguous, return null for that field rather than a guess. A wrong policy or receipt number is worse than a missing one.
`;

function buildPrompt(pageTexts) {
  const body = pageTexts
    .map((t, i) => `--- PAGE ${i + 1} ---\n${t}`)
    .join('\n\n');
  return TEXT_PROMPT + body;
}

/** Characters of real (non-whitespace) text pdf-text.js recovered from the PDF. */
function textCharsIn(pageTexts) {
  return pageTexts.join('').replace(/s/g, '').length;
}

/** How many of the given keys the model returned an actual value for. */
function countFilled(obj, keys) {
  return keys.filter((k) => obj[k] !== null && obj[k] !== undefined && obj[k] !== '').length;
}

const POLICY_KEYS = POLICY_SCHEMA.required.filter((k) => k !== 'members');

/**
 * Runs the Gemini extraction. Throws with a clear message if
 * GEMINI_API_KEY isn't configured, the PDF carried no text to send, or
 * the API call fails — callers should surface that rather than silently
 * falling through.
 *
 * Resolves to { parsed, diagnostics }.
 */
async function extractWithAi({ pageTexts, pdfBuffer = null }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const err = new Error('AI extraction is not configured: set GEMINI_API_KEY in the backend environment.');
    err.code = 'AI_NOT_CONFIGURED';
    err.diagnostics = { status: 'skipped', reason: 'NOT_CONFIGURED', model: MODEL_NAME, textChars: textCharsIn(pageTexts), pagesSent: pageTexts.length };
    throw err;
  }

  // A scanned PDF has no text layer, so pageTexts is empty and a text prompt
  // would carry nothing but instructions. Rather than fail, send the PDF
  // itself — the model reads the pages as images, which is the OCR step this
  // pipeline otherwise lacks. Costs more tokens per call than text, so it is
  // used only when there is genuinely no text to send.
  const textChars = textCharsIn(pageTexts);
  const useVision = textChars < MIN_TEXT_CHARS;

  if (useVision && !pdfBuffer) {
    const err = new Error(
      `This PDF has no extractable text (${textChars} characters across ${pageTexts.length} page(s)) and the ` +
      'file itself was not supplied, so it could not be read as images either.',
    );
    err.code = 'AI_NO_TEXT_LAYER';
    err.diagnostics = { status: 'skipped', reason: 'NO_TEXT_LAYER', model: MODEL_NAME, textChars, pagesSent: pageTexts.length };
    throw err;
  }

  if (useVision && pdfBuffer.length > MAX_INLINE_PDF_BYTES) {
    const mb = (pdfBuffer.length / 1024 / 1024).toFixed(1);
    const err = new Error(
      `This PDF is a scan with no text layer, and at ${mb}MB it is too large to send for visual reading ` +
      `(limit ${MAX_INLINE_PDF_BYTES / 1024 / 1024}MB). Split it or reduce its resolution, or OCR it before uploading.`,
    );
    err.code = 'AI_PDF_TOO_LARGE';
    err.diagnostics = { status: 'skipped', reason: 'PDF_TOO_LARGE', model: MODEL_NAME, textChars, pagesSent: pageTexts.length, inputMode: 'pdf-vision' };
    throw err;
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: MODEL_NAME,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: POLICY_SCHEMA,
    },
  });

  const startedAt = Date.now();
  const request = useVision
    ? [{ inlineData: { data: pdfBuffer.toString('base64'), mimeType: 'application/pdf' } }, { text: PDF_PROMPT }]
    : buildPrompt(pageTexts);

  const result = await model.generateContent(request);
  const text = result.response.text();
  const elapsedMs = Date.now() - startedAt;

  let extracted;
  try {
    extracted = JSON.parse(text);
  } catch {
    const err = new Error('AI extraction returned a response that could not be parsed as JSON.');
    err.code = 'AI_BAD_RESPONSE';
    err.diagnostics = { status: 'failed', reason: 'BAD_RESPONSE', model: MODEL_NAME, inputMode: useVision ? 'pdf-vision' : 'text', textChars, pagesSent: pageTexts.length, elapsedMs };
    throw err;
  }

  const parsed = {
    format: 'AI_EXTRACTED',
    ...extracted,
    policyTenureDays: tenureDaysFrom(extracted.policyStartDate, extracted.policyEndDate),
    policyReceiptDate: extracted.policyStartDate || null,
    planChosen: 'BASIC',
    members: (extracted.members || []).map((m) => ({
      ...m,
      policyTypeSelfParents: policyTypeSelfParentsCode(m.relationWithPolicyHolder),
    })),
  };

  return {
    parsed,
    diagnostics: {
      status: 'ran',
      reason: null,
      model: MODEL_NAME,
      inputMode: useVision ? 'pdf-vision' : 'text',
      textChars,
      pagesSent: pageTexts.length,
      elapsedMs,
      // What the model returned, before any merge decides what to keep.
      policyFieldsReturned: countFilled(extracted, POLICY_KEYS),
      policyFieldsTotal: POLICY_KEYS.length,
      membersReturned: (extracted.members || []).length,
      // The prompt tells the model to answer null rather than guess, so
      // these are genuine "not printed in this document" answers.
      emptyFields: POLICY_KEYS.filter((k) => extracted[k] === null || extracted[k] === undefined || extracted[k] === ''),
    },
  };
}

function tenureDaysFrom(startIso, endIso) {
  if (!startIso || !endIso) return null;
  const ms = Date.parse(`${endIso}T00:00:00Z`) - Date.parse(`${startIso}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return Math.round(ms / 86400000) + 1;
}

module.exports = { extractWithAi };
