/**
 * Rescue for a MIS group that was formed on a COLLIDED reference.
 *
 * Shared by card-matcher.js and upi-matcher.js, which group the MIS side
 * identically (by normalised reference) and so inherit the same weakness: a
 * reference is not reliably unique, so "these rows share a reference" does not
 * mean "these rows are one payment".
 *
 * TWO WAYS A REFERENCE COLLIDES, both confirmed against real client data:
 *
 *   Recycled code — a CARD approval code is 6 digits and the network reissues
 *   it. Approval code 004360 is a genuine ₹50,000 IP receipt settled on 07-Sep
 *   AND an unrelated ₹800 OP receipt from the 22-Sep upload. Summed, the group
 *   is ₹50,800 against a ₹50,000 settlement, so BOTH rows were reported as
 *   mismatched — destroying a match that was exact, same-day, same-amount.
 *
 *   Placeholder code — the HIS writes one code onto many bulk entries.
 *   Approval code 192081 sits on 144 unrelated ₹503 diagnostic receipts spanning
 *   eight days, and also on one real ₹73,941 VISA swipe (one card, one ARN, one
 *   terminal — verified; it is not a bulk settlement). Summing the 144 gives
 *   ₹72,432 and reported all of them short by ₹1,509. That ₹1,509 is the
 *   arithmetic of the collision. Nobody is owed it.
 *
 * WHY NOT DATE-WINDOW THE GROUP INSTEAD. The obvious fix — only group rows
 * dated near each other — was measured against the real data and rejected: of
 * 377 groups that DO reconcile cleanly, 38 span more than a day and some span
 * up to 14, so a window narrow enough to help would break genuine groups. It
 * also would not have fixed 192081, where 42 of the receipts fall on the swipe
 * date itself. Group membership is not the reliable signal; whether a member
 * reconciles ON ITS OWN is.
 *
 * WHAT THIS DOES. Only ever reached when a group of 2+ has already failed to
 * reconcile, so it can never disturb a clean match:
 *
 *   exactly one member reconciles with a candidate  -> that member is a true
 *       1:1 MATCH; every other member is UNMATCHED, told which reference they
 *       are sharing and with how many others.
 *   nobody reconciles                               -> every member is
 *       UNMATCHED for the same reason. Deliberately NOT AMOUNT_MISMATCH: that
 *       status asserts "your counterpart was found and it is short by X", and
 *       on a collided reference that sentence, and its number, are false. This
 *       is a client-facing audit figure — saying "could not match" is accurate,
 *       saying "short by ₹1,509" is not.
 *
 * AMBIGUITY. If two or more members each reconcile, none is picked: there is no
 * evidence saying which one owns the settlement, and guessing would be the same
 * mistake in a different place. All members go UNMATCHED.
 *
 * Pure and DB-free like its callers; returns verdicts in their exact shape.
 */

const MATCHED = 'MATCHED';
const UNMATCHED = 'UNMATCHED';

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const paise = (n) => Math.round((Number(n) || 0) * 100);

/**
 * @param key        the normalised reference the group was formed on
 * @param members    the MIS rows sharing it (always 2+ when this is called)
 * @param candidates the gateway rows carrying it — { sourceType?, sourceId, amount, date }
 * @param tolPaise   the policy tolerance, already in paise
 * @param sourceType fallback source tag for matchers whose candidates carry
 *                   none of their own (UPI — its only pool is UPI_MPR)
 *
 * @returns one verdict per member, same shape the matchers push themselves
 */
function rescueCollidedGroup({ key, members, candidates, tolPaise, sourceType = null }) {
  // Every (member, candidate) pair that reconciles on its own.
  const reconciling = [];
  for (const m of members) {
    const hit = candidates.find((c) => Math.abs(paise(c.amount) - paise(m.amount)) <= tolPaise);
    if (hit) reconciling.push({ member: m, candidate: hit });
  }

  // Exactly one, or nothing is claimed — see AMBIGUITY in the header comment.
  const winner = reconciling.length === 1 ? reconciling[0] : null;

  const sharedBy = members.length;
  const reason = winner
    ? { kind: 'COLLIDED_SIBLING', sharedBy }
    : { kind: 'COLLIDED_NO_MATCH', sharedBy, candidateAmounts: candidates.map((c) => round2(c.amount)) };

  return members.map((m) => {
    if (winner && winner.member === m) {
      const amount = round2(winner.candidate.amount);
      return {
        misRecordId: m.id,
        referenceId: key,
        misAmount: m.amount,
        // The group is disowned: this row stands alone, so its "group" is
        // itself. Reporting the collided total here would put the same
        // meaningless figure back on the row by another name.
        groupAmount: round2(m.amount),
        groupSize: 1,
        matchSourceType: winner.candidate.sourceType || sourceType,
        matchSourceId: winner.candidate.sourceId,
        matchedAmount: amount,
        matchedDate: winner.candidate.date || null,
        difference: round2(Number(m.amount) - amount),
        status: MATCHED,
        candidateCount: candidates.length,
        collision: { kind: 'COLLIDED_WINNER', sharedBy },
      };
    }
    return {
      misRecordId: m.id,
      referenceId: key,
      misAmount: m.amount,
      groupAmount: round2(m.amount),
      groupSize: 1,
      matchSourceType: null,
      matchSourceId: null,
      matchedAmount: null,
      matchedDate: null,
      // No counterpart was accepted, so there is no difference to state.
      difference: null,
      status: UNMATCHED,
      candidateCount: candidates.length,
      collision: reason,
    };
  });
}

module.exports = { rescueCollidedGroup };
