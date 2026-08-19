/**
 * Runs the extractor against a PDF and prints every field with its
 * confidence and source page. No DB or server needed.
 *
 *   node scripts/test-extraction.js [path-to.pdf]
 *
 * Defaults to the real client policy in test-fixtures/.
 */
const fs = require('fs');
const path = require('path');
const { extractPages } = require('../src/extraction/pdf-text');
const { parseByFormat, detectFormat } = require('../src/extraction/formats');
const { toExtractionResult } = require('../src/extraction/to-extraction-result');
const { toExcelRows } = require('../src/excel/excel-mapper');

const target = process.argv[2] || path.join(__dirname, '..', 'test-fixtures', 'real-policy.pdf');

(async () => {
  const buffer = fs.readFileSync(target);
  const started = Date.now();
  const { fullText, pageTexts } = await extractPages(buffer);

  const format = detectFormat(fullText);
  console.log(`file   : ${path.basename(target)}`);
  console.log(`pages  : ${pageTexts.length}`);
  console.log(`format : ${format ? format.id : 'UNRECOGNISED'}`);

  if (!format) {
    console.error('\nNo parser matches this layout. Add one under src/extraction/formats/.');
    process.exit(1);
  }

  const parsed = parseByFormat({ fullText, pageTexts });
  const { policy, fields, metadata } = toExtractionResult(parsed, {
    pagesAnalyzed: pageTexts.length,
    processingTimeMs: Date.now() - started,
  });

  console.log('\n--- fields ---');
  for (const f of fields) {
    const page = f.sourcePage ?? '-';
    console.log(
      `${f.confidence.padEnd(6)} ${String(f.confidenceScore).padStart(3)}%  p${String(page).padEnd(2)}  ${f.path.padEnd(34)} = ${JSON.stringify(f.value)}`,
    );
  }

  console.log('\n--- metadata ---');
  console.log(metadata);

  console.log('\n--- excel rows (one per insured member) ---');
  console.table(
    toExcelRows([{ ...parsed }]).map((r) => ({
      'S NO': r.sNo,
      POLICYHOLDER: r.policyholder,
      'POLICY NUMBER': r.policyNumber,
      'INSURED NAME': r.insuredName,
      RELATION: r.relationWithPolicyHolder,
      AGE: r.age,
      GENDER: r.gender,
      NOMINEE: r.nomineeName,
      'BASE PREMIUM': r.basePremium,
    })),
  );

  void policy;
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
