/**
 * Fallback extractor for insurers with no hand-written parser under
 * formats/. Unlike those parsers, this doesn't need per-insurer layout
 * knowledge: it hands the document's already-extracted text (see
 * pdf-text.js) to Gemini and asks for the same field shape every format
 * parser returns, via a JSON schema so the model can't drift from it.
 *
 * This is opt-in (called only when a user explicitly requests it after
 * the normal parser lookup fails with UNKNOWN_FORMAT), not a silent
 * fallback — each call costs an API request against the configured key's
 * quota.
 */

const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai');

// gemini-3.6-flash's free tier caps out at 20 requests/day — easy to burn
// through while testing. flash-lite trades a little capability for a much
// larger free quota and is still accurate enough for structured extraction
// (verified against hand-checked parser output before switching to it).
const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';

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

const PROMPT = `You are reading an Indian health insurance policy schedule extracted as plain text from a PDF. Extract the fields defined by the response schema.

Rules:
- Only report a value you can actually find in the text below. If a field isn't printed anywhere in the document, return null for it — never guess or infer a value that isn't stated.
- Dates must be ISO format (YYYY-MM-DD), converted from whatever format the document uses.
- "members" is the list of insured persons on the policy (not the policyholder unless the policyholder is also listed as an insured member with their own age/DOB/relation).
- "premium" is the net premium before tax; "totalPremium" is the final amount after tax; "gst" is the tax component (sum CGST+SGST+IGST if shown separately).
- policyTypeSelfParents is intentionally omitted from what you extract — do not include it.

Document text (each page marked, in reading order — table layouts may extract with cells out of visual order; use context and labels to resolve them):

`;

function buildPrompt(pageTexts) {
  const body = pageTexts
    .map((t, i) => `--- PAGE ${i + 1} ---\n${t}`)
    .join('\n\n');
  return PROMPT + body;
}

/**
 * Runs the Gemini fallback extraction. Throws with a clear message if
 * GEMINI_API_KEY isn't configured or the API call fails — callers should
 * surface that to the user rather than silently falling through.
 */
async function extractWithAi({ pageTexts }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const err = new Error('AI extraction is not configured: set GEMINI_API_KEY in the backend environment.');
    err.code = 'AI_NOT_CONFIGURED';
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

  const result = await model.generateContent(buildPrompt(pageTexts));
  const text = result.response.text();

  let extracted;
  try {
    extracted = JSON.parse(text);
  } catch {
    const err = new Error('AI extraction returned a response that could not be parsed as JSON.');
    err.code = 'AI_BAD_RESPONSE';
    throw err;
  }

  return {
    format: 'AI_EXTRACTED',
    ...extracted,
    policyTenureDays: tenureDaysFrom(extracted.policyStartDate, extracted.policyEndDate),
    policyReceiptDate: extracted.policyStartDate || null,
    planChosen: 'BASIC',
    members: (extracted.members || []).map((m) => ({ ...m, policyTypeSelfParents: 'A' })),
  };
}

function tenureDaysFrom(startIso, endIso) {
  if (!startIso || !endIso) return null;
  const ms = Date.parse(`${endIso}T00:00:00Z`) - Date.parse(`${startIso}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return Math.round(ms / 86400000) + 1;
}

module.exports = { extractWithAi };
