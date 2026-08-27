/**
 * Fields that a given product's document structurally never prints.
 *
 * This is not "the parser couldn't find it" — it's "the paper does not
 * carry it". The distinction matters because everything downstream treats a
 * blank field as something a human should go and fill in: it lowers the
 * confidence score, raises a warning in the validation centre, and pins the
 * document in "Needs Review" forever over data nobody can supply.
 *
 * Keyed by the format id each parser returns (and which is persisted on
 * policies.source_format), so this applies equally to a freshly-parsed
 * result and one re-validated from the database later.
 *
 * Only add an entry after confirming against the real document that the
 * field genuinely isn't printed — silencing a field the insurer *does*
 * print would hide a real extraction bug.
 */
const OMISSIONS = {
  // Care's bank-channel group certificate ("Group Care 360°(UHS)-2"):
  // verified against a real 6-page certificate — "Nominee" appears nowhere
  // in the document, the insured table has no gender/occupation/premium
  // columns (only Name, Client ID, DOB, Relationship, Insured-since, PED),
  // and the premium is a single flat figure with no discount line.
  CARE_GROUP_CERTIFICATE: [
    'nominee',
    'memberBasePremium',
    'gender',
    'occupation',
    'familyFloaterDiscount',
  ],
};

function omissionsFor(format) {
  return new Set(OMISSIONS[format] || []);
}

/** Policy-level `from` keys in to-extraction-result's POLICY_FIELDS, by omission key. */
const POLICY_FIELD_OMISSION = {
  familyFloaterDiscount: 'familyFloaterDiscount',
};

/** Member field keys in to-extraction-result's MEMBER_FIELDS, by omission key. */
const MEMBER_FIELD_OMISSION = {
  nomineeName: 'nominee',
  nomineeRelation: 'nominee',
  basePremium: 'memberBasePremium',
  gender: 'gender',
  occupation: 'occupation',
};

module.exports = {
  OMISSIONS, omissionsFor, POLICY_FIELD_OMISSION, MEMBER_FIELD_OMISSION,
};
