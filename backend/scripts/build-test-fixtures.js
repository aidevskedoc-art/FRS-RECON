const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

function writePdf(fileName, pages) {
  const outPath = path.join(__dirname, '..', 'test-fixtures', fileName);
  const doc = new PDFDocument({ margin: 50 });
  const stream = fs.createWriteStream(outPath);
  doc.pipe(stream);

  pages.forEach((lines, pageIndex) => {
    if (pageIndex > 0) doc.addPage();
    for (const [text, size] of lines) {
      doc.fontSize(size || 11).text(text);
      doc.moveDown(0.4);
    }
  });

  doc.end();
  return new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

const l = (text, size) => [text, size];

// Fixture A: clean, every field uses its PRIMARY label, full structured
// member lines. Should extract at high confidence across the board.
const fixtureA = [
  [
    l('CARE HEALTH INSURANCE LTD.', 16),
    l('Policy Schedule cum Certificate of Insurance', 11),
    l('Policyholder: Rajesh Reddy'),
    l('Customer ID: CHI-4471203'),
    l('Policyholder Address: Plot 14, Road No. 3, Banjara Hills, Hyderabad, Telangana 500034'),
    l('Insurance Company: Care Health Insurance Ltd.'),
    l('Insurance Company Address: Vipul Tech Square, Golf Course Road, Gurugram, Haryana 122002'),
    l('Policy Number: 90112233445566'),
    l('Policy Start Date: 30-07-2026'),
    l('Policy End Date: 29-07-2027'),
    l('Policy Tenure: 12 Months'),
    l('Policy Receipt Date: 29-07-2026'),
    l('Receipt Number: RCPT-2207781'),
    l('Plan Chosen: Care Freedom Plan'),
    l('Policy Type: Family Floater'),
    l('New/Renewal: New'),
  ],
  [
    l('PREMIUM BREAKUP', 13),
    l('Sum Insured: Rs. 10,00,000'),
    l('Total Basic Premium: Rs. 24,800'),
    l('Family Floater Discount: Rs. 1,240'),
    l('Premium: Rs. 23,560'),
    l('GST: Rs. 4,241'),
    l('Total Premium: Rs. 27,801'),
    l('Nominee Name: Lakshmi Reddy'),
    l('Nominee Relationship: Spouse'),
  ],
  [
    l('SCHEDULE OF INSURED MEMBERS', 13),
    l('1. Rajesh Reddy - Self - Age 41 - Male - Software Engineer - Base Premium Rs.9200 - Self', 10),
    l('2. Lakshmi Reddy - Spouse - Age 38 - Female - Homemaker - Base Premium Rs.7400 - Self', 10),
    l('3. Aarav Reddy - Son - Age 12 - Male - Student - Base Premium Rs.4100 - Self', 10),
    l('4. Ananya Reddy - Daughter - Age 9 - Female - Student - Base Premium Rs.4100 - Self', 10),
    l('TERMS AND CONDITIONS', 13),
    l('This is a computer generated sample document for extraction testing.', 9),
  ],
];

// Fixture B: several fields use FALLBACK label wording (medium confidence),
// a couple of fields are absent entirely (low confidence / blank), and the
// member section mixes one fully-structured line with two degraded ones —
// exercises the medium/low confidence paths, not just the happy path.
const fixtureB = [
  [
    l('STAR HEALTH AND ALLIED INSURANCE', 15),
    l('Policy Certificate', 11),
    l('Insured Name: Kavitha Nair'),
    l('Customer No: SHA-7729401'),
    l('Address: 17, Palm Grove Avenue, Adyar, Chennai, Tamil Nadu 600020'),
    l('Insurer: Star Health and Allied Insurance Co. Ltd.'),
    // Insurer Address intentionally omitted -> low confidence / blank
    l('Policy No.: P/2231/01234567'),
    l('Period of Insurance From: 08-Aug-2026'),
    l('Period of Insurance To: 07-Aug-2027'),
    l('Tenure: 12 Months'),
    l('Receipt Date: 07-Aug-2026'),
    l('Receipt No.: RCPT-3391204'),
    l('Product Name: Star Comprehensive Insurance Policy'),
    l('Cover Type: Individual'),
    // New/Renewal intentionally omitted -> low confidence / blank
  ],
  [
    l('PREMIUM BREAKUP', 13),
    l('Sum Assured: Rs. 5,00,000'),
    l('Basic Premium: Rs. 11,900'),
    // Family Floater Discount omitted (not applicable, individual policy) -> low confidence
    l('Net Premium: Rs. 11,900'),
    l('Tax: Rs. 2,142'),
    l('Premium Payable: Rs. 14,042'),
    l('Nominee: Ramachandra Rao'),
    l('Relationship with Nominee: Father'),
  ],
  [
    l('INSURED PARTICULARS', 13),
    l('1. Kavitha Nair - Self - Age 34 - Female - Chartered Accountant - Base Premium Rs.11900 - Self', 10),
    l('2. Meera Nair, Age 6', 10),
    l('3. Arjun Nair, Age 3', 10),
    l('TERMS AND CONDITIONS', 13),
    l('This is a computer generated sample document for extraction testing.', 9),
  ],
];

(async () => {
  fs.mkdirSync(path.join(__dirname, '..', 'test-fixtures'), { recursive: true });
  await writePdf('sample-policy-a.pdf', fixtureA);
  await writePdf('sample-policy-b.pdf', fixtureB);
  console.log('Test fixtures written.');
})();
