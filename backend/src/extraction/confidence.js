// Same thresholds as frontend/src/app/core/models/common.model.ts's
// CONFIDENCE_THRESHOLDS — kept numerically identical so a real document's
// confidence badges land in the same bucket the frontend already renders.
const CONFIDENCE_THRESHOLDS = { high: 90, medium: 75 };

function confidenceLevelFromScore(score) {
  if (score >= CONFIDENCE_THRESHOLDS.high) return 'high';
  if (score >= CONFIDENCE_THRESHOLDS.medium) return 'medium';
  return 'low';
}

module.exports = { CONFIDENCE_THRESHOLDS, confidenceLevelFromScore };
