import {
  BANK_STATEMENT_FIELD_OPTIONS,
  CONTRA_AMOUNT_FIELD_OPTIONS,
  CONTRA_KEY_FIELD_OPTIONS,
  ContraRuleConfig,
  DEFAULT_CONTRA_CONFIG,
  DEFAULT_UNIT_CONFIG,
  MatchingRule,
  PAYMENT_FIELD_OPTIONS,
  RULE_ACTIONS,
  RULE_FIELDS,
  RuleConditionGroup,
  RuleLeaf,
  UNIT_BANK_REF_OPTIONS,
  UNIT_PAYMENT_REF_OPTIONS,
  CHEQUE_UNIT_PAYMENT_REF_OPTIONS,
  DEFAULT_CHEQUE_UNIT_CONFIG,
  UnitRuleConfig,
} from '../../../core/models';
import { addDays, dayGap, dayWord, formatDay, inr, text } from './explain-format';
import { EngineRow, groupMatches, isIndexable, leafMatches, normalizeRef } from './rule-engine';
import { ExampleCheck, ExampleTable, ExplainStep, ExplainTone, RuleExample, RuleExplanation } from './rule-explanation.model';

/**
 * Explains an IP / Diagnostics / Cheque matching rule in plain language, with
 * a worked example built from the rule's own settings — so editing a rule, or
 * adding a new one, updates its explanation with nothing to maintain by hand.
 *
 * The wording follows what the engine actually does (backend rules.js,
 * unit-pass.js, contra-pass.js and the pass order in matched-rules.routes.js),
 * and rule-explainer.spec.ts runs every example through those same backend
 * functions.
 */

export type RuleStream = 'IP' | 'DIAG' | 'CHEQUE';

interface StreamWords {
  /** What one MIS row is called in sentences. */
  noun: string;
  rowHeading: string;
  /** The column a "Payment Mode" condition really reads on this stream (CHEQUE_OPTS / IP_OPTS / DIAG_OPTS). */
  paymentModeField: 'paymentMode' | 'payMode' | 'payType';
  afterConditions: string;
  receiptPrefix: string;
}

const STREAMS: Record<RuleStream, StreamWords> = {
  IP: {
    noun: 'payment',
    rowHeading: 'MIS row (IP collection)',
    paymentModeField: 'paymentMode',
    afterConditions: 'Payments that no condition rule matched then go to the grouped total rules.',
    receiptPrefix: 'IPR',
  },
  DIAG: {
    noun: 'payment',
    rowHeading: 'MIS row (Diagnostics / OP collection)',
    paymentModeField: 'payMode',
    afterConditions: 'Payments that no condition rule matched then go to the grouped total rules.',
    receiptPrefix: 'DFV',
  },
  CHEQUE: {
    noun: 'cheque',
    rowHeading: 'Cheque collection row',
    paymentModeField: 'payType',
    afterConditions: 'Cheques that no condition rule matched then go to the contra-entry rules (the refund document).',
    receiptPrefix: 'IDE',
  },
};

const SAMPLE_REF = '412345678901';
const OTHER_REF = '998877665544';
const UNITS = ['Somajiguda', 'Hitech City', 'Secunderabad', 'Malakpet'];

/** Realistic values to pick from when a condition needs a field to be — or not be — something. */
const POOLS: Record<string, string[]> = {
  paymentMode: ['NEFT', 'UPI', 'CARD', 'RTGS', 'CHEQUE', 'CASH'],
  patType: ['GEN', 'INT', 'CORP', 'INS'],
  payType: ['ADVANCE', 'FINAL', 'REFUND'],
  patientName: ['RAVI KUMAR', 'SITA DEVI'],
  userName: ['FRONTDESK01', 'CASHIER02'],
  remarks: ['PAID AT COUNTER', 'ONLINE'],
};

const PAYMENT_LABEL = new Map(PAYMENT_FIELD_OPTIONS.map((o) => [o.value, o.label]));
const PAYMENT_TYPE = new Map(PAYMENT_FIELD_OPTIONS.map((o) => [o.value, o.type]));
const BANK_LABEL = new Map(BANK_STATEMENT_FIELD_OPTIONS.map((o) => [o.value, o.label]));
const BANK_TYPE = new Map(BANK_STATEMENT_FIELD_OPTIONS.map((o) => [o.value, o.type]));

function paymentLabel(field: string | null, stream: RuleStream): string {
  if (field === 'paymentMode' && stream === 'CHEQUE') return "Payment Mode (the cheque's Pay Type column)";
  return PAYMENT_LABEL.get(field ?? '') ?? RULE_FIELDS.find((f) => f.value === field)?.label ?? field ?? '—';
}

function bankLabel(field: string | null): string {
  return BANK_LABEL.get(field ?? '') ?? field ?? '—';
}

const isBlank = (v: unknown) => v === null || v === undefined || v === '';
const unique = (list: string[]) => [...new Set(list)];

// --- outcome of a condition rule's action --------------------------------

const ACTION_STATUS: Record<string, { status: string; tone: ExplainTone }> = {
  FORCE_MATCHED: { status: 'Matched', tone: 'success' },
  FORCE_MATCHED_SAME_UNIT: { status: 'Matched', tone: 'success' },
  FORCE_MATCHED_OTHER_UNIT: { status: 'Matched', tone: 'success' },
  FORCE_MATCHED_TOL_SAME_UNIT: { status: 'Matched', tone: 'success' },
  FORCE_MATCHED_TOL_OTHER_UNIT: { status: 'Matched', tone: 'success' },
  FORCE_EASEBUZZ_MATCHED: { status: 'EaseBuzz Matched', tone: 'success' },
  FORCE_UNMATCHED: { status: 'Unmatched', tone: 'danger' },
  FORCE_MISMATCH: { status: 'Amount Mismatch', tone: 'danger' },
};

// --- sentences ------------------------------------------------------------

function leafSentence(leaf: RuleLeaf, stream: RuleStream): string {
  const noun = STREAMS[stream].noun;
  if (leaf.kind === 'LITERAL') {
    const label = paymentLabel(leaf.field, stream);
    const value = `“${leaf.value ?? ''}”`;
    if (leaf.operator === 'CONTAINS') return `${label} ${leaf.negate ? 'does not contain' : 'contains'} ${value}`;
    return `${label} ${leaf.negate ? 'is not' : 'is'} ${value}`;
  }
  const src = paymentLabel(leaf.sourceField, stream);
  const dst = bankLabel(leaf.destinationField);
  const not = leaf.negate;
  if (leaf.sourceField === 'division' && leaf.destinationField === 'divisionName' && leaf.pairOperator === 'EQUALS') {
    return `The ${noun} and the bank line belong to ${not ? 'different units' : 'the same unit'}`;
  }
  switch (leaf.pairOperator) {
    case 'EQUALS':
      return `${src} ${not ? 'is different from' : 'is the same as'} the bank's ${dst}`;
    case 'CONTAINS':
      return `${src} ${not ? 'does not appear' : 'appears'} in the bank's ${dst}`;
    case 'DATE_WITHIN_DAYS': {
      const n = Number(leaf.pairTolerance) || 0;
      if (n === 0) return `${src} is ${not ? 'not ' : ''}on the same day as the bank's ${dst}`;
      return `${src} is ${not ? 'more than' : 'within'} ${dayWord(n)} of the bank's ${dst}`;
    }
    case 'AMOUNT_WITHIN_TOLERANCE': {
      const t = Number(leaf.pairTolerance) || 0;
      if (t === 0) return `${src} ${not ? 'differs from' : 'equals'} the bank's ${dst}${not ? '' : ' exactly'}`;
      return `${src} is ${not ? 'more than' : 'within'} ${inr(t)} of the bank's ${dst}`;
    }
    default:
      return `${src} is compared with the bank's ${dst}`;
  }
}

function leafHowTo(leaf: RuleLeaf): string | null {
  if (leaf.kind === 'LITERAL') return 'Capital and small letters are treated the same.';
  switch (leaf.pairOperator) {
    case 'EQUALS':
      return leaf.sourceField === 'division'
        ? null
        : '“Is the same as” ignores capital/small letters, leading zeros and a single split letter at the start or end (412345678901A matches 0000412345678901).';
    case 'CONTAINS':
      return '“Appears in” finds the reference anywhere in the text — also as a separate word once leading zeros or a split letter are ignored.';
    case 'DATE_WITHIN_DAYS':
      return 'Counted either way — the bank date may be before or after.';
    case 'AMOUNT_WITHIN_TOLERANCE':
      return Number(leaf.pairTolerance) > 0 ? 'The difference may be either way — more or less.' : null;
    default:
      return null;
  }
}

function groupStep(group: RuleConditionGroup, stream: RuleStream): ExplainStep {
  const how = unique(group.map(leafHowTo).filter((d): d is string => !!d));
  if (group.every((l) => l.kind === 'LITERAL')) how.unshift(`This decides which ${STREAMS[stream].noun}s the rule applies to.`);
  const detail = how.join(' ') || undefined;
  if (group.length === 1) return { title: leafSentence(group[0], stream), detail };
  return { title: 'At least one of these is true:', options: group.map((l) => leafSentence(l, stream)), detail };
}

// --- building an example row pair ------------------------------------------

function paymentSample(field: string, stream: RuleStream): string | number {
  switch (field) {
    case 'receiptNumber':
      return stream === 'CHEQUE' ? 'IDE40591/26' : `${STREAMS[stream].receiptPrefix}24518`;
    case 'yhno':
      return 'YH1045872';
    case 'ipNo':
      return '119459';
    case 'chequeNo':
      return '004512';
    case 'transId':
    case 'transactionRef1':
    case 'transactionRef2':
      return SAMPLE_REF;
    case 'patientName':
      return 'RAVI KUMAR';
    case 'payType':
      return 'ADVANCE';
    case 'patType':
      return 'GEN';
    case 'paymentMode':
      return stream === 'CHEQUE' ? 'CHEQUE' : 'NEFT';
    case 'userName':
      return 'FRONTDESK01';
    case 'remarks':
      return 'PAID AT COUNTER';
    case 'division':
      return UNITS[0];
    case 'receiptDate':
      return '2026-08-12';
    case 'chequeDate':
      return '2026-08-10';
    case 'chequeAmount':
      return 25000;
    default:
      return stream === 'CHEQUE' ? 25000 : 5000;
  }
}

function narrationWith(ref: string, payment: EngineRow, stream: RuleStream): string {
  if (stream === 'CHEQUE') return `CLG/CHQ NO ${ref}/HDFC BANK`;
  if (String(payment['paymentMode'] ?? '').toUpperCase().includes('UPI')) return `UPI/${ref}/RAVI KUMAR/YASHODA HOSPITALS`;
  return `NEFT CR-HDFC0001234-RAVI KUMAR-${ref}`;
}

function otherUnit(unit: unknown): string {
  return UNITS.find((u) => u.toUpperCase() !== String(unit).toUpperCase()) ?? UNITS[1];
}

/** A believable narration that carries no reference — for a bank line matched through its Chq/Ref No. */
function plainNarration(payment: EngineRow, stream: RuleStream): string {
  if (stream === 'CHEQUE') return 'CLG/CHQ DEPOSIT/HDFC BANK';
  if (String(payment['paymentMode'] ?? '').toUpperCase().includes('UPI')) return 'UPI/RAVI KUMAR/YASHODA HOSPITALS';
  return 'NEFT CR-HDFC0001234-RAVI KUMAR';
}

/** The bank zero-pads Chq/Ref No. to 16 digits — shown that way so the example looks like a real statement. */
function padRef(value: string): string {
  return /^\d+$/.test(value) && value.length < 16 ? value.padStart(16, '0') : value;
}

function literalValue(leaf: RuleLeaf, stream: RuleStream, satisfy: boolean): string {
  const field = leaf.field ?? '';
  const want = String(leaf.value ?? '');
  const pool = [String(paymentSample(field, stream)), ...(POOLS[field] ?? []), 'OTHER'];
  const candidates = satisfy && !leaf.negate ? [want, ...pool] : leaf.negate && !satisfy ? [want, ...pool] : pool;
  const fits = (v: string) => leafMatches(leaf, { [field]: v }, {}) === satisfy;
  return candidates.find((v) => v !== '' && fits(v)) ?? want;
}

/** Fills in whatever this one condition needs to hold, without overwriting a value an earlier condition set. */
function satisfyLeaf(leaf: RuleLeaf, p: EngineRow, b: EngineRow, stream: RuleStream): void {
  if (leaf.kind === 'LITERAL') {
    const f = leaf.field ?? '';
    if (isBlank(p[f])) p[f] = literalValue(leaf, stream, true);
    return;
  }
  const sf = leaf.sourceField ?? '';
  const df = leaf.destinationField ?? '';
  if (isBlank(p[sf])) {
    // Two checks on the same bank field must agree, so take the value already there.
    const fromBank = df === 'chqRefNo' && !leaf.negate && !isBlank(b[df]) ? normalizeRef(b[df]) : null;
    p[sf] = fromBank ?? paymentSample(sf, stream);
  }
  const src = p[sf] as string | number;
  const other = sf === 'division' ? otherUnit(src) : OTHER_REF;
  switch (leaf.pairOperator) {
    case 'EQUALS':
      if (isBlank(b[df])) b[df] = df === 'chqRefNo' ? padRef(String(leaf.negate ? other : src)) : leaf.negate ? other : src;
      break;
    case 'CONTAINS':
      if (leaf.negate) {
        if (isBlank(b[df])) b[df] = df === 'narration' ? narrationWith(OTHER_REF, p, stream) : OTHER_REF;
      } else if (isBlank(b[df])) {
        b[df] = df === 'narration' ? narrationWith(String(src), p, stream) : String(src);
      } else if (!String(b[df]).toUpperCase().includes(String(src).toUpperCase())) {
        b[df] = `${b[df]}-${src}`;
      }
      break;
    case 'DATE_WITHIN_DAYS': {
      const n = Number(leaf.pairTolerance) || 0;
      if (isBlank(b[df])) b[df] = addDays(String(src), leaf.negate ? n + 3 : Math.min(n, 1));
      break;
    }
    case 'AMOUNT_WITHIN_TOLERANCE': {
      const t = Number(leaf.pairTolerance) || 0;
      if (isBlank(b[df])) b[df] = leaf.negate ? Number(src) + t + 500 : Number(src);
      break;
    }
  }
}

/** Makes this one condition fail (or, for a "not" condition, makes the thing it forbids true). */
function breakLeaf(leaf: RuleLeaf, p: EngineRow, b: EngineRow, stream: RuleStream): void {
  if (leaf.kind === 'LITERAL') {
    p[leaf.field ?? ''] = literalValue(leaf, stream, false);
    return;
  }
  const sf = leaf.sourceField ?? '';
  const df = leaf.destinationField ?? '';
  const src = p[sf];
  if (isBlank(src)) return;
  if (leaf.negate) {
    if (leaf.pairOperator === 'EQUALS' || leaf.pairOperator === 'CONTAINS') {
      b[df] = df === 'chqRefNo' ? padRef(String(src)) : df === 'narration' && leaf.pairOperator === 'CONTAINS' ? narrationWith(String(src), p, stream) : src;
    } else {
      b[df] = src;
    }
    return;
  }
  switch (leaf.pairOperator) {
    case 'EQUALS':
    case 'CONTAINS':
      if (sf === 'division') b[df] = otherUnit(src);
      else if (df === 'chqRefNo') b[df] = padRef(OTHER_REF);
      else if (df === 'narration') b[df] = narrationWith(OTHER_REF, p, stream);
      else b[df] = 'OTHER';
      break;
    case 'DATE_WITHIN_DAYS':
      b[df] = addDays(String(src), (Number(leaf.pairTolerance) || 0) + 5);
      break;
    case 'AMOUNT_WITHIN_TOLERANCE': {
      const t = Number(leaf.pairTolerance) || 0;
      b[df] = Number(src) - (t < 100 ? 500 : Math.ceil(t * 2));
      break;
    }
  }
}

function assign(target: EngineRow, source: EngineRow): void {
  for (const k of Object.keys(target)) delete target[k];
  Object.assign(target, source);
}

/**
 * A payment row + bank line that pass every check of the rule. Condition
 * groups that only filter the payment (Payment Mode is UPI…) are filled first,
 * since the bank narration is written to look like that kind of payment.
 * Returns null when no combination works — the rule contradicts itself.
 */
function buildMatching(groups: RuleConditionGroup[], stream: RuleStream): { p: EngineRow; b: EngineRow } | null {
  const p: EngineRow = {};
  const b: EngineRow = {};
  // Filters first, the most specific first: an exact "is X" before a "contains",
  // so "contains TPA" + "is TPA-MEDIASSIST" fills in TPA-MEDIASSIST, not TPA.
  const rank = (g: RuleConditionGroup) => {
    if (!g.every((l) => l.kind === 'LITERAL')) return 3;
    if (g.some((l) => !l.negate && l.operator === 'EQUALS')) return 0;
    return g.some((l) => !l.negate) ? 1 : 2;
  };
  const order = groups.map((_, i) => i).sort((x, y) => rank(groups[x]) - rank(groups[y]));
  const done: number[] = [];
  for (const gi of order) {
    const group = groups[gi];
    const tryOrder = [...group].sort((x, y) => Number(x.negate) - Number(y.negate));
    let ok = false;
    for (const leaf of tryOrder) {
      const sp = { ...p };
      const sb = { ...b };
      satisfyLeaf(leaf, p, b, stream);
      if (groupMatches(group, p, b) && done.every((d) => groupMatches(groups[d], p, b))) {
        ok = true;
        break;
      }
      assign(p, sp);
      assign(b, sb);
    }
    if (!ok) return null;
    done.push(gi);
  }
  return { p, b };
}

/** Which condition to break for the "does not match" example — the most instructive one first. */
function breakPriority(group: RuleConditionGroup): number {
  if (group.some((l) => l.pairOperator === 'AMOUNT_WITHIN_TOLERANCE')) return 0;
  if (group.some((l) => l.pairOperator === 'DATE_WITHIN_DAYS')) return 1;
  if (group.some((l) => l.sourceField === 'division')) return 2;
  if (group.every((l) => l.kind === 'LITERAL')) return 3;
  return 4;
}

function buildNonMatching(
  groups: RuleConditionGroup[],
  match: { p: EngineRow; b: EngineRow },
  stream: RuleStream,
): { p: EngineRow; b: EngineRow } | null {
  const order = groups.map((_, i) => i).sort((x, y) => breakPriority(groups[x]) - breakPriority(groups[y]));
  for (const gi of order) {
    const p = { ...match.p };
    const b = { ...match.b };
    for (const leaf of groups[gi]) breakLeaf(leaf, p, b, stream);
    const failing = groups.filter((g) => !groupMatches(g, p, b)).length;
    if (!groupMatches(groups[gi], p, b) && failing === 1) return { p, b };
  }
  return null;
}

// --- describing what an example shows ------------------------------------

function leafCheck(leaf: RuleLeaf, p: EngineRow, b: EngineRow, stream: RuleStream): string {
  if (leaf.kind === 'LITERAL') {
    const label = paymentLabel(leaf.field, stream);
    const actual = p[leaf.field ?? ''];
    const shown = isBlank(actual) ? 'is blank and' : `“${actual}”`;
    const holds = leafMatches({ ...leaf, negate: false }, p, b);
    const verb = leaf.operator === 'CONTAINS' ? (holds ? 'contains' : 'does not contain') : holds ? 'is' : 'is not';
    return `${label} ${shown} ${verb} “${leaf.value ?? ''}”`;
  }
  const sf = leaf.sourceField ?? '';
  const df = leaf.destinationField ?? '';
  const srcLabel = paymentLabel(sf, stream);
  const dstLabel = bankLabel(df);
  const src = p[sf];
  const dst = b[df];
  if (isBlank(src)) return `${srcLabel} is blank`;
  if (isBlank(dst)) return `The bank's ${dstLabel} is blank`;
  const holds = leafMatches({ ...leaf, negate: false }, p, b);
  const opposite = leaf.negate ? ' — this check needs the opposite' : '';
  switch (leaf.pairOperator) {
    case 'EQUALS': {
      if (sf === 'division') return `Unit ${src} ${holds ? '=' : '≠'} bank line unit ${dst}${opposite}`;
      const ignored = holds && String(src).toUpperCase() !== String(dst).toUpperCase() ? ' (leading zeros / split letter ignored)' : '';
      return `${srcLabel} ${src} ${holds ? '=' : '≠'} bank ${dstLabel} ${dst}${ignored}${opposite}`;
    }
    case 'CONTAINS':
      return `${srcLabel} ${src} ${holds ? 'is found' : 'is not found'} in the bank's ${dstLabel}${opposite}`;
    case 'DATE_WITHIN_DAYS': {
      const n = Number(leaf.pairTolerance) || 0;
      return `${formatDay(src)} and ${formatDay(dst)} are ${dayWord(dayGap(String(src), String(dst)))} apart — up to ${dayWord(n)} allowed${opposite}`;
    }
    case 'AMOUNT_WITHIN_TOLERANCE': {
      const t = Number(leaf.pairTolerance) || 0;
      const diff = Math.abs(Number(src) - Number(dst));
      return `${inr(src)} vs ${inr(dst)} — difference ${inr(diff)}, ${t === 0 ? 'must be exact' : `up to ${inr(t)} allowed`}${opposite}`;
    }
    default:
      return `${srcLabel} vs bank ${dstLabel}`;
  }
}

function groupCheck(group: RuleConditionGroup, p: EngineRow, b: EngineRow, stream: RuleStream): string {
  if (group.length === 1) return leafCheck(group[0], p, b, stream);
  const hit = group.find((l) => leafMatches(l, p, b));
  if (hit) return `${leafCheck(hit, p, b, stream)} — one option is enough`;
  return `None of the ${group.length} options holds — ${leafCheck(group[0], p, b, stream)}`;
}

function formatValue(value: unknown, type: string | undefined): string {
  if (isBlank(value)) return '—';
  if (type === 'date') return formatDay(value);
  if (type === 'number') return inr(value);
  return text(value);
}

function paymentTable(p: EngineRow, stream: RuleStream): ExampleTable {
  const keys = ['receiptNumber', ...PAYMENT_FIELD_OPTIONS.map((o) => o.value).filter((k) => k !== 'receiptNumber' && k in p)];
  return {
    heading: STREAMS[stream].rowHeading,
    columns: keys.map((k) => paymentLabel(k, stream)),
    rows: [keys.map((k) => formatValue(p[k], PAYMENT_TYPE.get(k)))],
  };
}

function bankTable(b: EngineRow): ExampleTable {
  const keys = ['txnDate', ...BANK_STATEMENT_FIELD_OPTIONS.map((o) => o.value).filter((k) => k !== 'txnDate' && k in b)];
  return {
    heading: 'Bank statement line',
    columns: keys.map((k) => bankLabel(k)),
    rows: [keys.map((k) => formatValue(b[k], BANK_TYPE.get(k)))],
  };
}

/** Everything the rule reads, so an OR-option the example leaves empty still shows as a blank column. */
function referencedFields(groups: RuleConditionGroup[]): { payment: string[]; bank: string[] } {
  const payment = new Set<string>();
  const bank = new Set<string>();
  for (const g of groups) {
    for (const l of g) {
      if (l.kind === 'LITERAL' && l.field) payment.add(l.field);
      if (l.kind === 'FIELD_PAIR') {
        if (l.sourceField) payment.add(l.sourceField);
        if (l.destinationField) bank.add(l.destinationField);
      }
    }
  }
  return { payment: [...payment], bank: [...bank] };
}

/**
 * What the backend engine is fed for this example, with the rule's ORIGINAL
 * conditions — so the spec also proves the cheque Pay Type substitution in
 * explainCondition is faithful.
 */
function engineInput(p: EngineRow, b: EngineRow, groups: RuleConditionGroup[], stream: RuleStream): Record<string, unknown> {
  const modeField = STREAMS[stream].paymentModeField;
  const payment: EngineRow = { ...p };
  // Diagnostics rows keep the payment mode in payMode, which is where the engine reads it.
  if (modeField === 'payMode' && 'paymentMode' in p) payment['payMode'] = p['paymentMode'];
  return { payment, bank: b, groups, paymentModeField: modeField };
}

// --- condition rule -------------------------------------------------------

function explainCondition(rule: MatchingRule, stream: RuleStream, allRules: MatchingRule[]): RuleExplanation {
  const words = STREAMS[stream];
  const groups = (rule.conditionGroups ?? []).filter((g) => g.length > 0);
  // On cheques the engine reads a "Payment Mode" condition from the Pay Type
  // column (CHEQUE_OPTS in matched-rules.routes.js), so the examples treat the
  // two as one column — otherwise a rule naming both could show a verdict the
  // engine would not give. The steps keep the rule's own wording.
  const evalGroups: RuleConditionGroup[] =
    stream === 'CHEQUE'
      ? groups.map((g) => g.map((l) => (l.kind === 'LITERAL' && l.field === 'paymentMode' ? { ...l, field: 'payType' as const } : l)))
      : groups;
  const exclude = rule.action === 'EXCLUDE';
  const verdict = ACTION_STATUS[rule.action] ?? { status: 'Unmatched', tone: 'danger' as ExplainTone };
  const actionLabel = RULE_ACTIONS.find((a) => a.value === rule.action)?.label;

  const outcome = exclude
    ? { label: 'Removes it from the list', tone: 'neutral' as ExplainTone }
    : { label: `Marks it ${verdict.status}${actionLabel && !actionLabel.startsWith('Force') ? ` (${actionLabel})` : ''}`, tone: verdict.tone };

  const checksBelow = groups.length === 1 ? 'the check below' : groups.length === 2 ? 'both checks below' : `all ${groups.length} checks below`;
  const when = `When a ${words.noun} and a bank statement line pass ${checksBelow}`;
  const summary = exclude
    ? `${when}, the ${words.noun} is left out of the reconciliation list altogether.`
    : rule.action === 'FORCE_UNMATCHED'
      ? `${when}, the ${words.noun} is marked Unmatched and no later condition rule is tried for it.`
      : `${when}, the ${words.noun} is marked ${verdict.status}.`;

  const activeConditionRules = allRules.filter((r) => r.kind === 'CNF' && r.active);
  const position = activeConditionRules.findIndex((r) => r.id === rule.id) + 1;
  const runOrder = [
    position > 0
      ? `Condition rules are tried from the top of the list. This is condition rule ${position} of ${activeConditionRules.length}.`
      : 'Condition rules are tried from the top of the list.',
    `The first condition rule that fits a bank line decides the result — rules below it are not tried for that ${words.noun}.`,
    'If more than one bank line fits, the one with the earliest date is used.',
    words.afterConditions,
  ];

  const warnings: string[] = [];
  if (!rule.active) warnings.push('This rule is switched off (Inactive). It is not used until it is made Active again.');
  if (groups.length === 0) warnings.push('This rule has no conditions, so it never matches anything.');
  if (groups.length > 0 && !isIndexable(groups)) {
    warnings.push(
      "This rule never compares a reference with the bank's Chq/Ref No. or Narration, so the engine cannot look up bank lines for it and skips it.",
    );
  }

  const examples: RuleExample[] = [];
  const match = groups.length ? buildMatching(evalGroups, stream) : null;
  if (groups.length && !match) {
    warnings.push('No example could be built: some of these checks contradict each other, so this rule may never match anything.');
  }
  if (match) {
    const refs = referencedFields(evalGroups);
    for (const f of refs.payment) if (!(f in match.p)) match.p[f] = null;
    for (const f of refs.bank) if (!(f in match.b)) match.b[f] = f === 'narration' ? plainNarration(match.p, stream) : null;
    if (!('receiptNumber' in match.p)) match.p['receiptNumber'] = paymentSample('receiptNumber', stream);
    if (!('txnDate' in match.b)) match.b['txnDate'] = '2026-08-13';

    // An "other unit" rule is easiest to understand with the two sides in different units.
    let note: string | undefined;
    const readsUnit = refs.payment.includes('division') || refs.bank.includes('divisionName');
    if (!readsUnit && /OTHER_UNIT$/.test(rule.action)) {
      match.p['division'] = UNITS[0];
      match.b['divisionName'] = UNITS[1];
      note = `The bank line is in a different unit (${UNITS[1]}) from the ${words.noun} (${UNITS[0]}) — this rule allows that.`;
    }

    const allPass = groups.length === 1 ? 'The check passes' : 'All checks pass';
    const matchChecks: ExampleCheck[] = evalGroups.map((g, i) => ({
      step: i + 1,
      ok: groupMatches(g, match.p, match.b),
      detail: groupCheck(g, match.p, match.b, stream),
    }));
    examples.push({
      title: 'Example — this pair matches',
      tables: [paymentTable(match.p, stream), bankTable(match.b)],
      checks: matchChecks,
      note,
      result: exclude
        ? `${allPass}, so the ${words.noun} is left out of the list.`
        : `${allPass}, so the ${words.noun} is marked ${verdict.status} by this rule.`,
      resultTone: exclude ? 'neutral' : verdict.tone,
      verification: { engine: 'CNF', input: engineInput(match.p, match.b, groups, stream), expected: { rule: 'MATCH' } },
    });

    const miss = buildNonMatching(evalGroups, match, stream);
    if (miss) {
      examples.push({
        title: 'Example — this pair does not match',
        tables: [paymentTable(miss.p, stream), bankTable(miss.b)],
        checks: evalGroups.map((g, i) => ({ step: i + 1, ok: groupMatches(g, miss.p, miss.b), detail: groupCheck(g, miss.p, miss.b, stream) })),
        result: `One check fails, so this rule does not apply. The ${words.noun} goes on to the next rule.`,
        resultTone: 'danger',
        verification: { engine: 'CNF', input: engineInput(miss.p, miss.b, groups, stream), expected: { rule: 'NO_MATCH' } },
      });
    }
  }

  return {
    name: rule.name,
    kindLabel: 'Condition rule',
    active: rule.active,
    outcome,
    summary,
    stepsHeading: groups.length === 1 ? 'The check' : groups.length === 2 ? 'The checks — both must pass' : `The checks — all ${groups.length} must pass`,
    steps: groups.map((g) => groupStep(g, stream)),
    outcomes: [],
    runOrder,
    examples,
    warnings,
  };
}

// --- same-unit total rule -------------------------------------------------

interface UnitRefs {
  refs: [string, string];
  key: string;
  how: string;
}

function unitRefs(mode: string): UnitRefs {
  if (mode === 'BASE') {
    return {
      refs: ['SBINR52026072936976501A', 'SBINR52026072936976501B'],
      key: 'SBINR52026072936976501',
      how: 'once the last letter is dropped',
    };
  }
  if (mode === 'AFFIX') return { refs: ['A952497', 'B952497'], key: '952497', how: 'once the A/B letter is dropped' };
  return { refs: ['SBIN0426072936976', 'SBIN0426072936976'], key: 'SBIN0426072936976', how: '' };
}

function keyModeDetail(mode: string): string {
  if (mode === 'BASE') return 'A last letter after the number is ignored, so …501A and …501B are one group.';
  if (mode === 'AFFIX') return 'A letter at the start or end is ignored, so A952497 and B952497 are one group.';
  return 'The references must be identical.';
}

/** How a grouped rule speaks on each tab: cheques group receipts on a cheque number, and a match reads "Grouped Matched". */
function unitWords(stream: RuleStream) {
  const cheque = stream === 'CHEQUE';
  return {
    cheque,
    rows: cheque ? 'receipts' : 'MIS rows',
    Rows: cheque ? 'Receipts' : 'MIS rows',
    amount: cheque ? 'Cheque Amount' : 'Bill Amount',
    matched: cheque ? 'Grouped Matched' : 'Matched',
  };
}

function explainUnit(rule: MatchingRule, stream: RuleStream, allRules: MatchingRule[]): RuleExplanation {
  const w = unitWords(stream);
  const cfg: UnitRuleConfig = { ...(w.cheque ? DEFAULT_CHEQUE_UNIT_CONFIG : DEFAULT_UNIT_CONFIG), ...(rule.unitConfig ?? {}) };
  const tol = Number(cfg.tolerance) || 0;
  const misToBank = cfg.direction !== 'BANK_TO_MIS';
  const refField = cfg.paymentRefField === 'AUTO' ? 'transactionRef1' : cfg.paymentRefField;
  const refLabel =
    cfg.paymentRefField === 'AUTO'
      ? 'Transaction Id (the first one filled of 1, 2, 3)'
      : ([...UNIT_PAYMENT_REF_OPTIONS, ...CHEQUE_UNIT_PAYMENT_REF_OPTIONS].find((o) => o.value === cfg.paymentRefField)?.label ??
        cfg.paymentRefField);
  const bankRefLabel = UNIT_BANK_REF_OPTIONS.find((o) => o.value === cfg.bankRefField)?.label ?? 'Chq/Ref No.';
  const bankWhere = cfg.useNarration
    ? 'its Chq/Ref No. or as a word in its Narration'
    : cfg.bankRefField === 'narration'
      ? 'a word of its Narration'
      : `its ${bankRefLabel}`;
  const scopeText =
    cfg.scope === 'BATCH'
      ? 'Only rows from the same upload are added together.'
      : cfg.scope === 'NONE'
        ? 'Rows from any unit may be added together.'
        : 'Only rows from the same unit are added together, and the bank line must be in that unit too.';
  const amountRule = tol > 0 ? `, within ${inr(tol)}` : ', to the paisa';

  const steps: ExplainStep[] = misToBank
    ? [
        {
          title: `${w.Rows} are grouped by their ${refLabel}`,
          detail:
            `${keyModeDetail(cfg.unitKeyMode)} Only groups of two or more are handled here — a single ${w.cheque ? 'receipt' : 'row'} is left to the condition rules.` +
            (cfg.paymentRefField === 'chequeNo'
              ? ' The placeholder cheque numbers 12345, 123456 and 1234567 are never grouped — each is shared by many unrelated receipts.'
              : ''),
        },
        { title: scopeText },
        { title: `The group is paired with the bank credit that carries the same ${w.cheque ? 'cheque number' : 'reference'} in ${bankWhere}` },
        { title: `The group's total ${w.amount} must equal that bank credit's Deposit Amount${amountRule}` },
      ]
    : [
        {
          title: "Bank lines are grouped by their Chq/Ref No.",
          detail: `${keyModeDetail(cfg.unitKeyMode)} Only groups of two or more bank lines are handled here.`,
        },
        { title: scopeText },
        { title: `The group is paired with the MIS row whose ${refLabel} is that reference` },
        { title: `The bank lines' total Deposit Amount must equal that row's Bill Amount${amountRule}` },
      ];

  const other = misToBank ? 'the bank credit' : 'the MIS row';
  const outcomes = [
    { when: `The total equals ${other}`, status: w.matched, tone: 'success' as ExplainTone },
    { when: `The total is less than ${other} — part of the money is not found yet`, status: 'Partial Match', tone: 'danger' as ExplainTone },
    { when: `The total is more than ${other}`, status: 'Amount Mismatch', tone: 'danger' as ExplainTone },
    {
      when: `More than one ${misToBank ? 'bank credit' : 'MIS row'} carries the reference — it never picks one`,
      status: 'Multiple Matches Found',
      tone: 'danger' as ExplainTone,
    },
    { when: `Nothing carries the reference`, status: 'No change', tone: 'neutral' as ExplainTone },
  ];

  const unitRules = allRules.filter((r) => r.kind === 'UNIT_AGGREGATION' && r.active);
  const position = unitRules.findIndex((r) => r.id === rule.id) + 1;
  const listIndex = allRules.findIndex((r) => r.id === rule.id);
  const aboveConditionRules = allRules.some((r, i) => r.kind === 'CNF' && r.active && i > listIndex);
  const runOrder = [
    'Runs after all condition rules, only on rows they did not match. A Matched row is never touched, and a bank credit already used by a Matched row is never used again.',
    position > 0
      ? `Total rules run in list order among themselves — this is total rule ${position} of ${unitRules.length}. A later total rule can still turn an earlier one's Partial Match or Amount Mismatch into Matched.`
      : 'Total rules run in list order among themselves.',
  ];
  if (aboveConditionRules) runOrder.push('Its place above condition rules in the list does not make it run before them — condition rules always go first.');
  if (w.cheque) runOrder.push('It runs before the contra-entry rules, so a cheque it matches to the bank is never taken for a refund.');

  const warnings = rule.active ? [] : ['This rule is switched off (Inactive). It is not used until it is made Active again.'];
  // unit-pass.js scopes the MIS side by upload batch but bank lines by nothing,
  // so the two never meet and a same-batch rule matches no row at all. Say so
  // rather than show an example the engine would not produce.
  const batchScope = cfg.scope === 'BATCH';
  if (batchScope) {
    warnings.push(
      "With 'Same upload batch' this rule currently matches nothing — bank lines have no upload batch to compare with. Choose 'Same unit' or 'Any unit' instead.",
    );
  }
  const examples = batchScope ? [] : [unitExample(cfg, stream, refField, refLabel, 'match'), unitExample(cfg, stream, refField, refLabel, 'short')];

  return {
    name: rule.name,
    kindLabel: 'Grouped total rule',
    active: rule.active,
    outcome: { label: misToBank ? `Matches several ${w.rows} to one bank credit` : 'Matches several bank lines to one MIS row', tone: 'success' },
    summary:
      w.cheque && misToBank
        ? 'One cheque sometimes pays for several receipts. This rule adds up the receipts that share a cheque number and compares the total with the one bank credit carrying that cheque number.'
        : misToBank
          ? 'One bank credit sometimes pays for several MIS rows. This rule adds up the MIS rows that share a reference and compares the total with the one bank credit carrying that reference.'
      : 'One MIS row is sometimes paid by several bank credits. This rule adds up the bank lines that share a reference and compares the total with the one MIS row carrying that reference.',
    stepsHeading: 'How it works',
    steps,
    outcomes,
    runOrder,
    examples,
    warnings,
  };
}

function unitExample(
  cfg: UnitRuleConfig,
  stream: RuleStream,
  refField: string,
  refLabel: string,
  variant: 'match' | 'short',
): RuleExample {
  const w = unitWords(stream);
  const misToBank = cfg.direction !== 'BANK_TO_MIS';
  // A cheque example looks like cheque 127760: one real cheque number on two
  // receipts, the bank's Chq/Ref No. zero-padded as HDFC prints it.
  const byCheque = cfg.paymentRefField === 'chequeNo';
  const { refs, key, how } = byCheque
    ? { refs: ['127760', '127760'] as [string, string], key: '127760', how: '' }
    : unitRefs(cfg.unitKeyMode);
  const prefix = STREAMS[stream].receiptPrefix;
  const u1 = UNITS[0];
  const u2 = cfg.scope === 'NONE' ? UNITS[1] : u1;
  const parts: [number, number] = w.cheque ? [12000, 5355] : [150000, 150000];
  const whole = parts[0] + parts[1];
  const expectedOther = variant === 'match' ? whole : whole + (w.cheque ? 2000 : 20000);
  const refColumn = cfg.paymentRefField === 'AUTO' ? 'Transaction Id 1' : refLabel;
  const receiptNos = w.cheque ? ['ORS21951/26', 'ORS21953/26'] : [`${prefix}24518`, `${prefix}24533`];

  const bankNarration = (ref: string) =>
    w.cheque
      ? `CHQ DEP - HYDERABAD - CTS CLG2${cfg.bankRefField === 'narration' ? `-${ref}` : ''} - RAVI KUMAR`
      : cfg.bankRefField === 'narration'
        ? `NEFT CR-SBIN0001234-${ref}-YASHODA HOSPITALS`
        : 'NEFT CR-SBIN0001234-YASHODA HOSPITALS';
  const bankChq = (ref: string) =>
    cfg.bankRefField === 'narration' && !cfg.useNarration ? '' : byCheque ? ref.padStart(16, '0') : ref;

  let tables: ExampleTable[];
  let input: Record<string, unknown>;
  let expected: Record<string, string>;
  const status = variant === 'match' ? 'MATCHED' : 'PARTIAL_MATCH';

  if (misToBank) {
    const records = [
      { id: '1', receiptNumber: receiptNos[0], [refField]: refs[0], division: u1, batchId: '12', billAmount: parts[0] },
      { id: '2', receiptNumber: receiptNos[1], [refField]: refs[1], division: u2, batchId: '12', billAmount: parts[1] },
    ];
    const bank = { id: 'b1', txnDate: '2026-08-13', chqRefNo: bankChq(key), narration: bankNarration(key), divisionName: u1, depositAmt: expectedOther };
    tables = [
      {
        heading: w.cheque ? 'Cheque collection rows' : 'MIS rows',
        columns: ['Receipt Number', refColumn, 'Unit', w.amount],
        rows: records.map((r) => [r.receiptNumber, String(r[refField]), r.division, inr(r.billAmount)]),
      },
      {
        heading: 'Bank statement line',
        columns: ['Transaction Date', 'Chq/Ref No.', 'Narration', 'Unit', 'Deposit Amount'],
        rows: [[formatDay(bank.txnDate), text(bank.chqRefNo), bank.narration, bank.divisionName, inr(bank.depositAmt)]],
      },
    ];
    input = { direction: 'MIS_TO_BANK', records, bankRecords: [bank] };
    expected = { '1': status, '2': status };
  } else {
    const bankRows = [
      { id: 'b1', txnDate: '2026-08-13', chqRefNo: refs[0], narration: 'NEFT CR-SBIN0001234-YASHODA HOSPITALS', divisionName: u1, depositAmt: parts[0] },
      { id: 'b2', txnDate: '2026-08-14', chqRefNo: refs[1], narration: 'NEFT CR-SBIN0001234-YASHODA HOSPITALS', divisionName: u2, depositAmt: parts[1] },
    ];
    const record = { id: '1', receiptNumber: `${prefix}24518`, [refField]: key, division: u1, batchId: '12', billAmount: expectedOther };
    tables = [
      {
        heading: 'Bank statement lines',
        columns: ['Transaction Date', 'Chq/Ref No.', 'Unit', 'Deposit Amount'],
        rows: bankRows.map((r) => [formatDay(r.txnDate), r.chqRefNo, r.divisionName, inr(r.depositAmt)]),
      },
      {
        heading: 'MIS row',
        columns: ['Receipt Number', refColumn, 'Unit', w.amount],
        rows: [[record.receiptNumber, key, record.division, inr(record.billAmount)]],
      },
    ];
    input = { direction: 'BANK_TO_MIS', records: [record], bankRecords: bankRows };
    expected = { '1': status };
  }

  const rowsWord = misToBank ? w.rows : 'bank lines';
  const groupedCheck = how
    ? `${refs[0]} and ${refs[1]} both become ${key} ${how}`
    : `Both ${rowsWord} carry the same ${byCheque ? 'cheque number' : 'reference'} ${key}`;
  const scopeCheck =
    cfg.scope === 'NONE'
      ? `The ${rowsWord} are in ${u1} and ${u2} — allowed, because this rule adds up across units`
      : `Both ${rowsWord} and the ${misToBank ? 'bank credit' : 'MIS row'} are in ${u1}`;
  const pairCheck = misToBank ? `One bank credit carries ${key}` : `One MIS row carries ${key}`;
  const shortBy = expectedOther - whole;
  const amountCheck =
    variant === 'match'
      ? `${inr(parts[0])} + ${inr(parts[1])} = ${inr(whole)}, equal to ${misToBank ? 'the bank credit' : 'the MIS amount'} ${inr(expectedOther)}`
      : `${inr(parts[0])} + ${inr(parts[1])} = ${inr(whole)}, which is ${inr(shortBy)} less than ${misToBank ? 'the bank credit' : 'the MIS amount'} ${inr(expectedOther)}`;

  const target = misToBank ? `Both ${w.rows} are` : 'The MIS row is';
  return {
    title: variant === 'match' ? 'Example — the total matches' : 'Example — the total falls short',
    tables,
    checks: [
      { step: 1, ok: true, detail: groupedCheck },
      { step: 2, ok: true, detail: scopeCheck },
      { step: 3, ok: true, detail: pairCheck },
      { step: 4, ok: variant === 'match', detail: amountCheck },
    ],
    result:
      variant === 'match'
        ? `${target} marked ${w.matched}.`
        : `${target} marked Partial Match — ${inr(shortBy)} of ${misToBank ? 'this credit' : 'this receipt'} is not accounted for yet.`,
    resultTone: variant === 'match' ? 'success' : 'danger',
    verification: {
      engine: 'UNIT',
      input: {
        ...input,
        rule: { name: 'example', ...cfg },
      },
      expected,
    },
  };
}

// --- contra entry rule ----------------------------------------------------

function explainContra(rule: MatchingRule, allRules: MatchingRule[]): RuleExplanation {
  const cfg: ContraRuleConfig = { ...DEFAULT_CONTRA_CONFIG, ...(rule.contraConfig ?? {}) };
  const keyFields = cfg.keyFields?.length ? cfg.keyFields : DEFAULT_CONTRA_CONFIG.keyFields;
  const keyLabel = (f: string) => CONTRA_KEY_FIELD_OPTIONS.find((o) => o.value === f)?.label ?? f;
  const amountLabel = CONTRA_AMOUNT_FIELD_OPTIONS.find((o) => o.value === cfg.amountField)?.label ?? 'Cheque Amount';
  const tol = Number(cfg.tolerance) || 0;
  const window = cfg.dateWindowDays === null || cfg.dateWindowDays === undefined ? null : Number(cfg.dateWindowDays);
  const keys = keyFields.map(keyLabel);
  const joinedKeys = keys.length > 1 ? `${keys.slice(0, -1).join(', ')} and ${keys[keys.length - 1]}` : keys[0];

  const tieBreak =
    cfg.onAmbiguous === 'AMBIGUOUS_MATCH'
      ? 'If there is still more than one, the cheque is marked Multiple Matches Found.'
      : cfg.onAmbiguous === 'CLAIM_FIRST'
        ? 'If there is still more than one, the first one is taken.'
        : 'If there is still more than one, the cheque is left Unmatched and the reason says so.';

  const steps: ExplainStep[] = [
    {
      title: 'Only cheques still Unmatched after the bank-statement rules are checked',
      detail: 'A cheque in Partial Match, Amount Mismatch or Multiple Matches Found is left alone — it may still reach the bank.',
    },
    {
      title: `The refund must have the same ${joinedKeys}`,
      detail: `Leading zeros are ignored (004512 = 4512). If any of ${keys.length > 1 ? 'these' : 'this'} is blank on the cheque, this rule skips it.`,
    },
    { title: `The cheque's ${amountLabel} must equal the refund amount${tol > 0 ? `, within ${inr(tol)}` : ' exactly'}` },
    { title: window === null ? 'Dates are not compared' : `The refund date must be within ${dayWord(window)} of the receipt date` },
    { title: cfg.scope === 'DIVISION' ? 'The refund must be from the same unit' : 'The refund can be from any unit' },
    { title: 'If several refunds fit, the one closest in date to the receipt is taken', detail: `${tieBreak} Each refund line can settle only one cheque.` },
  ];

  const contraRules = allRules.filter((r) => r.kind === 'CONTRA_ENTRY' && r.active);
  const position = contraRules.findIndex((r) => r.id === rule.id) + 1;

  return {
    name: rule.name,
    kindLabel: 'Contra entry rule',
    active: rule.active,
    outcome: { label: 'Marks it Contra Entry', tone: 'success' },
    summary:
      'A cheque that was collected and then refunded never reaches the bank, so the bank rules can only call it Unmatched. This rule finds it in the refund document and marks it Contra Entry instead.',
    stepsHeading: 'How it works',
    steps,
    outcomes: [
      { when: 'Exactly one refund fits', status: 'Contra Entry', tone: 'success' },
      {
        when: 'Several refunds fit even after the date tie-break',
        status: cfg.onAmbiguous === 'AMBIGUOUS_MATCH' ? 'Multiple Matches Found' : cfg.onAmbiguous === 'CLAIM_FIRST' ? 'Contra Entry (first one)' : 'Stays Unmatched',
        tone: cfg.onAmbiguous === 'CLAIM_FIRST' ? 'success' : 'danger',
      },
      { when: 'No refund fits', status: 'Stays Unmatched', tone: 'danger' },
    ],
    runOrder: [
      'Runs last — after the bank-statement condition rules — and only on cheques still Unmatched.',
      position > 0
        ? `Contra rules run in list order: this is contra rule ${position} of ${contraRules.length}. A later one only sees cheques the earlier ones did not settle.`
        : 'Contra rules run in list order; a later one only sees cheques the earlier ones did not settle.',
    ],
    examples: [contraExample(cfg, keyFields, window, 'match'), contraExample(cfg, keyFields, window, 'short')],
    warnings: rule.active ? [] : ['This rule is switched off (Inactive). It is not used until it is made Active again.'],
  };
}

function contraExample(cfg: ContraRuleConfig, keyFields: string[], window: number | null, variant: 'match' | 'short'): RuleExample {
  const unit = UNITS[1];
  const amount = 52000;
  const refundAmount = variant === 'match' ? amount : 50000;
  const cheque: EngineRow = {
    id: '1',
    receiptNumber: 'IDE40591/26',
    chequeNo: '004512',
    ipNo: '119459',
    yhno: 'YH1045872',
    patientName: 'RAVI KUMAR',
    division: unit,
    receiptDate: '2026-07-23',
    chequeAmount: amount,
    billAmount: amount,
  };
  const refund: EngineRow = {
    id: 'r1',
    refundNo: 'IRF11479',
    chequeNo: '4512',
    ipNo: '119459',
    yhno: 'YH1045872',
    patientName: 'RAVI KUMAR',
    division: unit,
    chequeDate: '2026-07-23',
    amount: refundAmount,
  };
  const keyLabel = (f: string) => CONTRA_KEY_FIELD_OPTIONS.find((o) => o.value === f)?.label ?? f;
  const amountLabel = CONTRA_AMOUNT_FIELD_OPTIONS.find((o) => o.value === cfg.amountField)?.label ?? 'Cheque Amount';

  const keyChecks = keyFields
    .map((f) => {
      const a = String(cheque[f]);
      const b = String(refund[f]);
      return `${keyLabel(f)} ${a} = ${b}${a !== b ? ' (leading zeros ignored)' : ''}`;
    })
    .join('; ');
  const diff = Math.abs(amount - refundAmount);
  const checks: ExampleCheck[] = [
    { step: 1, ok: true, detail: 'No bank line matched this cheque, so it is still Unmatched' },
    { step: 2, ok: true, detail: keyChecks },
    {
      step: 3,
      ok: variant === 'match',
      detail: `${inr(amount)} vs ${inr(refundAmount)} — difference ${inr(diff)}${Number(cfg.tolerance) > 0 ? `, up to ${inr(cfg.tolerance)} allowed` : ', must be exact'}`,
    },
  ];
  if (window !== null) checks.push({ step: 4, ok: true, detail: `Both dated ${formatDay(cheque['receiptDate'])} — 0 days apart, up to ${dayWord(window)} allowed` });
  if (cfg.scope === 'DIVISION') checks.push({ step: 5, ok: true, detail: `Both are in ${unit}` });

  return {
    title: variant === 'match' ? 'Example — this cheque is a contra entry' : 'Example — this cheque is not a contra entry',
    tables: [
      {
        heading: 'Cheque collection row',
        columns: ['Receipt Number', ...keyFields.map(keyLabel), 'Unit', 'Receipt Date', amountLabel],
        rows: [[text(cheque['receiptNumber']), ...keyFields.map((f) => text(cheque[f])), unit, formatDay(cheque['receiptDate']), inr(amount)]],
      },
      {
        heading: 'Refund document row',
        columns: ['Refund No', ...keyFields.map(keyLabel), 'Unit', 'Refund Date', 'Refund Amount'],
        rows: [[text(refund['refundNo']), ...keyFields.map((f) => text(refund[f])), unit, formatDay(refund['chequeDate']), inr(refundAmount)]],
      },
    ],
    checks,
    result:
      variant === 'match'
        ? 'Everything agrees, so the cheque is marked Contra Entry — it was refunded, not banked.'
        : `The amounts differ by ${inr(diff)}, so it is not a contra entry. The cheque stays Unmatched.`,
    resultTone: variant === 'match' ? 'success' : 'danger',
    verification: {
      engine: 'CONTRA',
      input: { records: [cheque], refundRecords: [refund], rule: { name: 'example', ...cfg, keyFields } },
      expected: { '1': variant === 'match' ? 'CONTRA_ENTRY' : 'UNMATCHED' },
    },
  };
}

// --- entry point -----------------------------------------------------------

/**
 * @param rule     the rule to explain
 * @param stream   which screen it belongs to — decides wording and sample values
 * @param allRules every rule on that screen, in list order — to say where this one runs
 */
export function explainMatchingRule(rule: MatchingRule, stream: RuleStream, allRules: MatchingRule[]): RuleExplanation {
  if (rule.kind === 'UNIT_AGGREGATION') return explainUnit(rule, stream, allRules);
  if (rule.kind === 'CONTRA_ENTRY') return explainContra(rule, allRules);
  return explainCondition(rule, stream, allRules);
}
