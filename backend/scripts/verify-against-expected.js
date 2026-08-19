/**
 * Compares the extractor's Excel output against the client's supplied
 * expected-output workbook, cell by cell. This is the real acceptance test:
 * it fails loudly on any divergence rather than reporting "extraction ran".
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { extractPages } = require('../src/extraction/pdf-text');
const { parseByFormat } = require('../src/extraction/formats');
const { EXCEL_COLUMNS, toExcelRows } = require('../src/excel/excel-mapper');

const FIXTURES = path.join(__dirname, '..', 'test-fixtures');

/** Excel serial (1900 system) -> 'YYYY-MM-DD'. */
function serialToIso(serial) {
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  return new Date(ms).toISOString().slice(0, 10);
}

/** Normalises both sides so 1000000 == '10,00,000' and dates compare as ISO. */
function normalise(value, key) {
  if (value === null || value === undefined || value === '') return '';

  const dateKeys = ['policyStartDate', 'policyEndDate', 'policyReceiptDate'];
  if (dateKeys.includes(key)) {
    if (typeof value === 'number') return serialToIso(value);
    return String(value).slice(0, 10);
  }

  if (typeof value === 'number') return String(value);

  const s = String(value).trim();
  const numeric = s.replace(/,/g, '');
  // Only numify what survives a float round-trip. A 20-digit receipt number
  // exceeds Number's 15-significant-digit precision, so converting it here
  // would silently corrupt the very value being compared.
  if (/^-?\d+(\.\d+)?$/.test(numeric) && numeric.replace(/\D/g, '').length <= 15) {
    return String(Number(numeric));
  }
  return s.replace(/\s+/g, ' ');
}

(async () => {
  const buffer = fs.readFileSync(path.join(FIXTURES, 'real-policy.pdf'));
  const { fullText, pageTexts } = await extractPages(buffer);
  const policy = parseByFormat({ fullText, pageTexts });
  const actualRows = toExcelRows([policy]);

  const wb = XLSX.readFile(path.join(FIXTURES, 'output-template.xlsx'));
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  const expectedRows = raw.slice(1).filter((r) => r.some((c) => c !== ''));

  console.log(`expected rows: ${expectedRows.length}   actual rows: ${actualRows.length}\n`);

  let mismatches = 0;
  const rowCount = Math.max(expectedRows.length, actualRows.length);

  for (let r = 0; r < rowCount; r++) {
    const expected = expectedRows[r] || [];
    const actual = actualRows[r] || {};

    EXCEL_COLUMNS.forEach((col, c) => {
      const exp = normalise(expected[c], col.key);
      const act = normalise(actual[col.key], col.key);
      if (exp !== act) {
        mismatches++;
        console.log(`row ${r + 1} | ${col.header}`);
        console.log(`   expected: ${JSON.stringify(exp)}`);
        console.log(`   actual  : ${JSON.stringify(act)}`);
      }
    });
  }

  console.log(mismatches === 0 ? '\nEXACT MATCH — all cells agree.' : `\n${mismatches} mismatched cell(s).`);
  process.exit(mismatches === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
