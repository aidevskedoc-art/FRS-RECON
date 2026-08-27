const unitedIndia = require('./united-india');
const royalSundaram = require('./royal-sundaram');
const newIndia = require('./new-india');
const starHealth = require('./star-health');
const acko = require('./acko');
const care = require('./care');
const careGroup = require('./care-group');
const galaxy = require('./galaxy');
const national = require('./national');
const bajaj = require('./bajaj');
const iciciLombard = require('./icici-lombard');
const oriental = require('./oriental');
const manipalCigna = require('./manipal-cigna');
const reliance = require('./reliance');
const hdfcErgo = require('./hdfc-ergo');
const adityaBirla = require('./aditya-birla');
const tataAig = require('./tata-aig');
const magma = require('./magma');
const nivaBupa = require('./niva-bupa');

/**
 * Format registry. Each entry exposes matches(fullText) and parse({pageTexts}).
 * Adding a new insurer means adding one module here — the routes, DB layer,
 * and Excel mapper stay untouched, since every parser returns the same shape.
 */
const FORMATS = [
  { id: 'UNITED_INDIA_FAMILY_MEDICARE', module: unitedIndia },
  { id: 'ROYAL_SUNDARAM_POLICY_SCHEDULE', module: royalSundaram },
  { id: 'NEW_INDIA_FLOATER_MEDICLAIM', module: newIndia },
  { id: 'STAR_HEALTH_POLICY_SCHEDULE', module: starHealth },
  { id: 'ACKO_HEALTH_POLICY_SCHEDULE', module: acko },
  // Ahead of CARE_HEALTH_POLICY_CERTIFICATE: the group certificate carries
  // the more specific signature, and detectFormat takes the first match.
  { id: 'CARE_GROUP_CERTIFICATE', module: careGroup },
  { id: 'CARE_HEALTH_POLICY_CERTIFICATE', module: care },
  { id: 'GALAXY_HEALTH_POLICY_SCHEDULE', module: galaxy },
  { id: 'NATIONAL_PARIVAR_MEDICLAIM_PLUS', module: national },
  { id: 'BAJAJ_FAMILY_HEALTH_CARE', module: bajaj },
  { id: 'ICICI_LOMBARD_GROUP_HEALTH_POLICY', module: iciciLombard },
  { id: 'ORIENTAL_BANK_SAATHI_POLICY', module: oriental },
  { id: 'MANIPALCIGNA_SARVAH_POLICY_SCHEDULE', module: manipalCigna },
  { id: 'RELIANCE_HEALTH_GAIN_POLICY_SCHEDULE', module: reliance },
  { id: 'HDFC_ERGO_OPTIMA_RESTORE_FLOATER', module: hdfcErgo },
  { id: 'ADITYA_BIRLA_ACTIV_ONE', module: adityaBirla },
  { id: 'TATA_AIG_MEDICARE_PREMIER', module: tataAig },
  { id: 'MAGMA_ONEHEALTH_POLICY_SCHEDULE', module: magma },
  { id: 'NIVA_BUPA_REASSURE_POLICY', module: nivaBupa },
];

/**
 * `headText` (the first two pages) is what each parser's INSURER check
 * runs against, not the whole document — a schedule routinely quotes a
 * *different* insurer's full legal name in its portability/previous-
 * policy section, which would otherwise false-positive as that insurer's
 * own format. Product/scheme name (SIGNATURE) checks still run against
 * the whole document, since those aren't the kind of thing a policy
 * quotes about a different insurer.
 */
function detectFormat(fullText, pageTexts = []) {
  const headText = pageTexts.length ? pageTexts.slice(0, 4).join('\n') : fullText;
  return FORMATS.find((f) => f.module.matches(fullText, headText)) || null;
}

function parseByFormat({ fullText, pageTexts }) {
  const format = detectFormat(fullText, pageTexts);
  if (!format) {
    const err = new Error(
      'Unrecognised policy layout. Supported formats: '
        + FORMATS.map((f) => f.id).join(', ')
        + '. Add a parser under src/extraction/formats/ for this insurer.',
    );
    err.code = 'UNKNOWN_FORMAT';
    throw err;
  }
  return format.module.parse({ fullText, pageTexts });
}

module.exports = { FORMATS, detectFormat, parseByFormat };
