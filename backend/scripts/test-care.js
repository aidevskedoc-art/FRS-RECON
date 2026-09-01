#!/usr/bin/env node
/**
 * Regression harness for the two Care Health Insurance parsers.
 *
 * Runs every Care PDF under uploads/ (or a directory given as the first
 * argument) through detection + parsing and reports, per format:
 *   - documents that threw, or that no format claimed;
 *   - how many documents left each policy field empty;
 *   - member rows whose values landed in the wrong column, caught by
 *     checking each value against the shape its column must have (a date
 *     where a date belongs, a relationship word where a relationship
 *     belongs) rather than by eyeballing the output.
 *
 * The column checks are the point: a member table read one column out
 * still produces a full set of plausible-looking values, so "nothing is
 * null" is not evidence that it parsed correctly.
 *
 * Usage: node scripts/test-care.js [dir] [--json out.json]
 */

const fs = require('fs');
const path = require('path');
const { extractPages } = require('../src/extraction/pdf-text');
const { detectFormat, parseByFormat } = require('../src/extraction/formats');

const POLICY_FIELDS = [
  'policyNumber', 'newOrRenewal', 'insuranceCompany', 'insuranceCompanyLegalName',
  'insuranceCompanyAddress', 'policyholderName', 'policyholderAddress', 'customerId',
  'policyStartDate', 'policyEndDate', 'policyTenureDays', 'policyReceiptDate',
  'printedReceiptDate', 'receiptNumber', 'policyType', 'planChosen', 'sumInsured',
  'totalBasicPremium', 'premium', 'totalPremium',
];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RELATION = /^(SELF|MEMBER|SPOUSE|WIFE|HUSBAND|SON|DAUGHTER|MOTHER|FATHER|BROTHER|SISTER|MOTHER-IN-LAW|FATHER-IN-LAW|OTHER)$/i;

/** Anything that would mean a value came out of the wrong column. */
function memberProblems(m) {
  const bad = [];
  if (!m.name) bad.push('name empty');
  else if (!/[A-Za-z]/.test(m.name)) bad.push(`name "${m.name}" has no letters`);
  else if (ISO_DATE.test(m.name) || /^\d+$/.test(m.name)) bad.push(`name "${m.name}" is a number/date`);
  else if (m.name.length > 60) bad.push(`name "${m.name}" ran into the next cell`);

  if (!m.dateOfBirth) bad.push('dateOfBirth empty');
  else if (!ISO_DATE.test(m.dateOfBirth)) bad.push(`dateOfBirth "${m.dateOfBirth}" not a date`);

  if (m.relationWithPolicyHolder == null) bad.push('relation empty');
  else if (!RELATION.test(String(m.relationWithPolicyHolder).trim())) {
    bad.push(`relation "${m.relationWithPolicyHolder}" is not a relationship`);
  }

  if (m.age == null) bad.push('age empty');
  else if (!Number.isFinite(m.age) || m.age < 0 || m.age > 120) bad.push(`age "${m.age}" out of range`);

  if (m.inceptionDate != null && !ISO_DATE.test(m.inceptionDate)) {
    bad.push(`inceptionDate "${m.inceptionDate}" not a date`);
  }
  return bad;
}

/** Totals the document prints in more than one place, which must agree. */
function policyProblems(p) {
  const bad = [];
  if (p.policyStartDate && p.policyEndDate && p.policyStartDate >= p.policyEndDate) {
    bad.push(`period ${p.policyStartDate}..${p.policyEndDate} not increasing`);
  }
  const parts = (p.premium || 0) + (p.gst || 0);
  if (p.totalPremium && parts && Math.abs(parts - p.totalPremium) > 1) {
    bad.push(`premium ${p.premium} + gst ${p.gst} = ${parts.toFixed(2)} != total ${p.totalPremium}`);
  }
  if (p.sumInsured != null && p.sumInsured < 10000) bad.push(`sumInsured ${p.sumInsured} implausible`);
  return bad;
}

async function main() {
  const args = process.argv.slice(2);
  const jsonAt = args.indexOf('--json');
  const jsonOut = jsonAt === -1 ? null : args[jsonAt + 1];
  const dir = path.resolve(args[0] && !args[0].startsWith('--') ? args[0] : path.join(__dirname, '..', 'uploads'));

  const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.pdf')).sort();
  const results = [];
  let failures = 0;

  for (const file of files) {
    const { fullText, pageTexts, pageItems } = await extractPages(fs.readFileSync(path.join(dir, file)));
    if (!/Care Health Insurance/i.test(fullText)) continue;

    const format = detectFormat(fullText, pageTexts);
    if (!format) {
      console.log(`FAIL  ${file}: no format matched`);
      failures++;
      results.push({ file, error: 'UNRECOGNISED' });
      continue;
    }

    let parsed;
    try {
      parsed = parseByFormat({ fullText, pageTexts, pageItems });
    } catch (err) {
      console.log(`FAIL  ${file} [${format.id}]: threw ${err.message}`);
      failures++;
      results.push({ file, format: format.id, error: err.message });
      continue;
    }

    const problems = policyProblems(parsed);
    if (!parsed.members.length) problems.push('no members parsed');
    parsed.members.forEach((m, i) => {
      memberProblems(m).forEach((p) => problems.push(`member[${i}] ${p}`));
    });

    if (problems.length) {
      failures++;
      console.log(`FAIL  ${file} [${format.id}]`);
      problems.forEach((p) => console.log(`        ${p}`));
    }
    results.push({ file, format: format.id, problems, parsed });
  }

  const byFormat = {};
  for (const r of results) {
    const key = r.format || 'UNRECOGNISED';
    byFormat[key] ||= { docs: 0, members: 0, empty: {} };
    byFormat[key].docs++;
    if (!r.parsed) continue;
    byFormat[key].members += r.parsed.members.length;
    for (const f of POLICY_FIELDS) {
      const v = r.parsed[f];
      if (v === null || v === undefined || v === '') (byFormat[key].empty[f] ||= []).push(r.file);
    }
  }

  console.log(`\n${'='.repeat(64)}\nCare documents: ${results.length}   documents with problems: ${failures}`);
  for (const [id, s] of Object.entries(byFormat)) {
    console.log(`\n${id} — ${s.docs} document(s), ${s.members} member row(s)`);
    const empty = Object.entries(s.empty);
    if (!empty.length) console.log('  every policy field populated on every document');
    empty.forEach(([f, docs]) => console.log(`  empty on ${String(docs.length).padStart(3)}/${s.docs}: ${f}`));
  }

  if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify(results, null, 1));
    console.log(`\nfull output -> ${jsonOut}`);
  }
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
