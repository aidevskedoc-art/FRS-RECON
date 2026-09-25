/**
 * THE rule for whether one report in an uploaded file is stored — used by
 * BOTH the manual Upload & Run screen (via POST /api/uploads/detect, which
 * attaches it to every match as `decision`) and the shared-folder scheduler
 * (folder-watch/ingest.js). One copy, so the two can never disagree again:
 * on 2026-09-25 the scheduler's own stricter copy dropped 13,638 Diag
 * receipts over 3 held-back ones that the manual screen stored fine.
 *
 * Only the cases where storing would be WRONG are skipped:
 *   - the report could not be read safely (totals don't tie / structural error)
 *   - nothing new in it (empty, or every row already stored)
 * Rows already stored from an overlapping earlier file are left out by the
 * dry run itself (and by the upload route), so only new rows are stored.
 * Everything else is stored, and anything a person should know about —
 * held-back receipts, skipped already-stored rows, totals that could not be
 * checked, sheet warnings — is returned as `warnings` to show, not as a
 * question to answer.
 */
const { CONFIDENT } = require('./detect-file-type');

/**
 * @param {object|undefined} p  a his-preview.js dry-run preview
 * @returns {{ action: 'STORE'|'SKIP', outcome: string, message: string|null, warnings: string[] }}
 *   outcome uses folder_watch_run_files' vocabulary: INGESTED (to be stored),
 *   SKIPPED_DUPLICATE, SKIPPED_EMPTY, SKIPPED_NEEDS_REVIEW.
 */
function decideReport(p) {
  if (!p) return { action: 'STORE', outcome: 'INGESTED', message: null, warnings: [] }; // no dry run for this type — the upload route decides

  if (p.status === 'FAILED') {
    const problems = (p.sheets || []).flatMap((s) => s.problems.filter((pr) => pr.severity === 'error').map((pr) => `${s.sheetName}: ${pr.message}`));
    const detail = problems.length ? problems.join(' | ') : (p.notes || []).join(' ') || 'no detail';
    return skip('SKIPPED_NEEDS_REVIEW', `Could not be read safely, not stored: ${detail}`);
  }
  if (p.ingest.rows === 0 && p.alreadyStored?.rows) return skip('SKIPPED_DUPLICATE', 'Every row in this report is already stored.');
  if (p.ingest.rows === 0) return skip('SKIPPED_EMPTY', 'This report holds nothing to store.');
  const warnings = [];
  if (p.alreadyStored?.rows) {
    warnings.push(`${p.alreadyStored.rows} row(s) already stored from an earlier file were skipped; only the ${p.ingest.rows} new row(s) are stored.`);
  }
  const heldBack = p.heldBack || [];
  if (heldBack.length) {
    const list = heldBack.map((h) => `${h.receiptNo} (₹${h.amount})`).join(', ');
    warnings.push(`${heldBack.length} receipt(s) not stored, need a person: ${list} — ${heldBack[0].reason}`);
  }
  const splitPaid = p.splitPaid || [];
  if (splitPaid.length) {
    const list = splitPaid.map((h) => `${h.receiptNo} (₹${h.amount})`).join(', ');
    warnings.push(`${splitPaid.length} receipt(s) ${splitPaid[0].reason} — stored with both references, shown as Unmatched until checked: ${list}`);
  }
  if (p.status === 'UNVERIFIED') warnings.push('Its totals could not be checked against the report’s printed totals.');
  for (const s of p.sheets || []) {
    for (const pr of s.problems) if (pr.severity !== 'error') warnings.push(`${s.sheetName}: ${pr.message}`);
  }
  return { action: 'STORE', outcome: 'INGESTED', message: warnings.length ? warnings.join(' | ') : null, warnings };
}

function skip(outcome, message) {
  return { action: 'SKIP', outcome, message, warnings: [] };
}

/**
 * Every report found in one file, decided. `matches` are detect-file-type
 * matches with his-preview.js previews attached (attachHisPreviews).
 *
 *   - A combined HIS workbook: each report on its own dry run (decideReport);
 *     a report with no dry run is stored only if it was recognised with
 *     confidence. Nothing for a person to pick — `needsType` is false.
 *   - An ordinary single-report file: the best match is stored when the
 *     detector is certain; otherwise `needsType` — a person picks the type
 *     (the only thing that can't be decided automatically).
 *
 * @returns {{ needsType: boolean, decisions: Array<{ type, label, action, outcome, message, warnings }> }}
 */
function decideFile(matches, certain) {
  if (matches.length === 0) return { needsType: true, decisions: [] };
  const hasPreview = matches.some((m) => m.preview);

  if (!hasPreview) {
    if (!certain) {
      const labels = matches.map((m) => m.label).join(', ');
      return {
        needsType: true,
        decisions: [{ type: matches[0].type, label: matches[0].label, ...skip('SKIPPED_NEEDS_REVIEW', `Not certain which report this is (${labels}) — a person must pick the type.`) }],
      };
    }
    // Only the best match; the other candidates simply aren't chosen.
    return {
      needsType: false,
      decisions: [{ type: matches[0].type, label: matches[0].label, action: 'STORE', outcome: 'INGESTED', message: null, warnings: [] }],
    };
  }

  return {
    needsType: false,
    decisions: matches.map((m) => ({
      type: m.type,
      label: m.label,
      ...(m.preview
        ? decideReport(m.preview)
        : m.confidence >= CONFIDENT
          ? { action: 'STORE', outcome: 'INGESTED', message: null, warnings: [] }
          : skip('SKIPPED_NEEDS_REVIEW', `Only a weak match for ${m.label}.`)),
    })),
  };
}

module.exports = { decideReport, decideFile };
