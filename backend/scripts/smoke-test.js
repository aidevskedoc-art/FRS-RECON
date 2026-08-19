// End-to-end round trip against a RUNNING server (npm start in another
// terminal) and a real PostgreSQL instance. Asserts against known values
// from test-fixtures/sample-policy-a.pdf, not just "didn't crash."
const fs = require('fs');
const path = require('path');

const BASE = process.env.SMOKE_BASE_URL || 'http://localhost:4000';

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`  ok: ${msg}`);
  } else {
    console.error(`  FAIL: ${msg}`);
    failures++;
  }
}

async function api(method, urlPath, body) {
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (!res.ok) {
    throw new Error(`${method} ${urlPath} -> ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function run() {
  console.log(`Smoke test against ${BASE}\n`);

  console.log('health check');
  const health = await api('GET', '/api/health');
  assert(health.status === 'ok', 'GET /api/health returns ok');

  console.log('\nupload sample-policy-a.pdf');
  const fileBuffer = fs.readFileSync(path.join(__dirname, '..', 'test-fixtures', 'sample-policy-a.pdf'));
  const form = new FormData();
  form.append('files', new Blob([fileBuffer], { type: 'application/pdf' }), 'sample-policy-a.pdf');
  const uploadRes = await fetch(`${BASE}/api/documents/upload`, { method: 'POST', body: form });
  const uploaded = await uploadRes.json();
  assert(uploadRes.ok, 'upload succeeds');
  assert(Array.isArray(uploaded) && uploaded.length === 1, 'one document created');
  const documentId = uploaded[0].id;
  assert(uploaded[0].status === 'Uploaded', 'new document status is Uploaded');
  console.log(`  documentId = ${documentId}`);

  console.log('\nextract');
  const extraction = await api('POST', `/api/documents/${documentId}/extract`);
  assert(extraction.policy.policyHolder.name === 'Rajesh Reddy', 'policyholder extracted correctly');
  assert(extraction.policy.policyNumber === '90112233445566', 'policy number extracted correctly');
  assert(extraction.policy.premium.totalPremium === 27801, 'total premium extracted correctly');
  assert(extraction.policy.members.length === 4, 'all 4 members extracted');
  assert(extraction.metadata.overallConfidence === 'high', 'overall confidence is high for a clean document');
  assert(extraction.fields.every((f) => f.confidence === 'high'), 'every field is high confidence');

  const docAfterExtract = await api('GET', `/api/documents/${documentId}`);
  assert(docAfterExtract.status === 'Completed', 'document status became Completed after a clean extraction');

  console.log('\nGET extraction (persisted reload)');
  const reloaded = await api('GET', `/api/documents/${documentId}/extraction`);
  assert(reloaded.policy.policyNumber === '90112233445566', 'extraction reloads correctly from the DB');
  assert(reloaded.fields.length === extraction.fields.length, 'same field count after reload');

  console.log('\nvalidation');
  const validation = await api('GET', `/api/documents/${documentId}/validation`);
  assert(validation.completenessPercent === 100, 'clean document validates at 100% completeness');
  assert(validation.isSaveBlocked === false, 'clean document is not save-blocked');

  console.log('\nPATCH a field');
  await api('PATCH', `/api/documents/${documentId}/extraction/fields`, { path: 'premium.gst', value: 5000 });
  const afterPatch = await api('GET', `/api/documents/${documentId}/extraction`);
  assert(afterPatch.policy.premium.gst === 5000, 'field value updated');
  const gstField = afterPatch.fields.find((f) => f.path === 'premium.gst');
  assert(gstField.verified === true && gstField.confidence === 'high', 'patched field marked verified/high-confidence');

  console.log('\nadd / duplicate / remove member');
  const beforeCount = afterPatch.policy.members.length;
  const added = await api('POST', `/api/documents/${documentId}/members`, {
    name: 'Test Member', relationWithPolicyHolder: 'Other', age: 30, gender: 'Other', occupation: 'Tester', basePremium: 1000, policyTypeSelfParents: 'Self',
  });
  assert(added.members.length === beforeCount + 1, 'member added');
  const newMemberId = added.members[added.members.length - 1].id;

  const duplicated = await api('POST', `/api/documents/${documentId}/members/${newMemberId}/duplicate`);
  assert(duplicated.members.length === beforeCount + 2, 'member duplicated');
  assert(duplicated.members.some((m) => m.name === 'Test Member (Copy)'), 'duplicate has "(Copy)" suffix');

  const toRemove = duplicated.members[duplicated.members.length - 1].id;
  const afterRemove = await api('DELETE', `/api/documents/${documentId}/members/${toRemove}`);
  assert(afterRemove.members.length === beforeCount + 1, 'member removed');

  console.log('\nGET /api/policies lists the saved policy');
  const policies = await api('GET', '/api/policies');
  const savedPolicy = policies.find((p) => p.documentId === documentId);
  assert(!!savedPolicy, 'policy appears in GET /api/policies');
  assert(savedPolicy.members.length === beforeCount + 1, 'member count matches in policy listing');

  console.log('\nmark excel generated');
  const excelMarked = await api('PATCH', `/api/policies/${savedPolicy.id}/excel-generated`);
  assert(!!excelMarked.excelGeneratedAt, 'excelGeneratedAt set');

  console.log('\nupload + extract sample-policy-b.pdf (mixed confidence)');
  const fileBufferB = fs.readFileSync(path.join(__dirname, '..', 'test-fixtures', 'sample-policy-b.pdf'));
  const formB = new FormData();
  formB.append('files', new Blob([fileBufferB], { type: 'application/pdf' }), 'sample-policy-b.pdf');
  const uploadResB = await fetch(`${BASE}/api/documents/upload`, { method: 'POST', body: formB });
  const uploadedB = await uploadResB.json();
  const documentIdB = uploadedB[0].id;
  const extractionB = await api('POST', `/api/documents/${documentIdB}/extract`);
  assert(extractionB.metadata.overallConfidence !== 'high', 'mixed-quality document does not score high overall');
  const docBAfter = await api('GET', `/api/documents/${documentIdB}`);
  assert(docBAfter.status === 'Needs Review', 'mixed-confidence document status becomes Needs Review');

  console.log('\ncascade delete');
  await api('DELETE', `/api/documents/${documentIdB}`);
  const policiesAfterDelete = await api('GET', '/api/policies');
  assert(!policiesAfterDelete.some((p) => p.documentId === documentIdB), 'policy cascade-deleted with its document');

  console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error('\nSMOKE TEST CRASHED:', err.message);
  process.exit(1);
});
