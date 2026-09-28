import { MatchingRule, RuleConditionGroup, RuleLeaf, UnitRuleConfig, ContraRuleConfig } from '../../../core/models';
import { GatewayRule, GatewayRuleConfig, GatewayTarget } from '../../../core/models/gateway-rules.model';
import { explainGatewayRule } from './explain-gateway-rule';
import { explainMatchingRule, RuleStream } from './explain-matching-rule';
import { RuleExample, RuleExplanation } from './rule-explanation.model';

/*
 * The Rule details panel tells an auditor "this pair matches, that one does
 * not". Those claims must be what the reconciliation engine would really
 * conclude, so every example is fed to the BACKEND functions below — not to
 * the panel's own copy of the logic — and must get the verdict it shows.
 */
// @ts-ignore — plain CommonJS backend modules, no type declarations
import * as rulesEngine from '../../../../../../backend/src/reconciliation/rules.js';
// @ts-ignore
import * as unitPass from '../../../../../../backend/src/reconciliation/unit-pass.js';
// @ts-ignore
import * as contraPass from '../../../../../../backend/src/reconciliation/contra-pass.js';
// @ts-ignore
import * as cardMatcher from '../../../../../../backend/src/reconciliation/upi-card-recon/card-matcher.js';
// @ts-ignore
import * as upiMatcher from '../../../../../../backend/src/reconciliation/upi-card-recon/upi-matcher.js';
// @ts-ignore
import * as payuSettlement from '../../../../../../backend/src/reconciliation/payu-settlement.js';
// @ts-ignore
import * as easebuzzSettlement from '../../../../../../backend/src/reconciliation/easebuzz-settlement.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyRow = Record<string, any>;

// --- fixtures ---------------------------------------------------------------

const pair = (sourceField: string, pairOperator: RuleLeaf['pairOperator'], destinationField: string, extra: Partial<RuleLeaf> = {}): RuleLeaf => ({
  kind: 'FIELD_PAIR',
  negate: false,
  field: null,
  operator: null,
  value: null,
  sourceField,
  destinationField,
  pairOperator,
  pairTolerance: null,
  ...extra,
});

const literal = (field: RuleLeaf['field'], operator: RuleLeaf['operator'], value: string, negate = false): RuleLeaf => ({
  kind: 'LITERAL',
  negate,
  field,
  operator,
  value,
  sourceField: null,
  destinationField: null,
  pairOperator: null,
  pairTolerance: null,
});

const refGroup = (a: string, b: string): RuleConditionGroup => [
  pair(a, 'EQUALS', 'chqRefNo'),
  pair(a, 'CONTAINS', 'narration'),
  pair(b, 'EQUALS', 'chqRefNo'),
  pair(b, 'CONTAINS', 'narration'),
];
const amount = (field: string, tol: string): RuleConditionGroup => [pair(field, 'AMOUNT_WITHIN_TOLERANCE', 'depositAmt', { pairTolerance: tol })];
const sameUnit: RuleConditionGroup = [pair('division', 'EQUALS', 'divisionName')];

let nextId = 1;
function cnf(name: string, action: MatchingRule['action'], conditionGroups: RuleConditionGroup[], active = true): MatchingRule {
  return { id: String(nextId++), name, action, active, kind: 'CNF', unitConfig: null, contraConfig: null, sortOrder: nextId, conditionGroups, createdAt: '', updatedAt: '' };
}
function unit(name: string, cfg: Partial<UnitRuleConfig> & Record<string, unknown>): MatchingRule {
  const unitConfig = { scope: 'DIVISION', direction: 'MIS_TO_BANK', tolerance: 0, unitKeyMode: 'EXACT', bankRefField: 'chqRefNo', useNarration: true, paymentRefField: 'AUTO', ...cfg } as UnitRuleConfig;
  return { id: String(nextId++), name, action: 'FORCE_MATCHED', active: true, kind: 'UNIT_AGGREGATION', unitConfig, contraConfig: null, sortOrder: nextId, conditionGroups: [], createdAt: '', updatedAt: '' };
}
function contra(name: string, cfg: Partial<ContraRuleConfig>): MatchingRule {
  const contraConfig = { scope: 'NONE', keyFields: ['chequeNo', 'ipNo'], tolerance: 0, amountField: 'chequeAmount', onAmbiguous: 'UNMATCHED', dateWindowDays: null, ...cfg } as ContraRuleConfig;
  return { id: String(nextId++), name, action: 'FORCE_MATCHED', active: true, kind: 'CONTRA_ENTRY', unitConfig: null, contraConfig, sortOrder: nextId, conditionGroups: [], createdAt: '', updatedAt: '' };
}

const notUpi = [literal('paymentMode', 'CONTAINS', 'UPI', true)];
const isUpi = [literal('paymentMode', 'CONTAINS', 'UPI')];

/** The rules saved in the database on 2026-09-28, plus shapes they don't cover yet. */
const RULE_SETS: { stream: RuleStream; rules: MatchingRule[] }[] = [
  {
    stream: 'IP',
    rules: [
      unit('Transaction Amount Match on Same Unit', {}),
      unit('Transaction Amount Match on Other Units', { scope: 'NONE', unitKeyMode: 'AFFIX' }),
      cnf('Online — reference matches bank (same unit)', 'FORCE_MATCHED_SAME_UNIT', [notUpi, refGroup('transId', 'transactionRef2'), amount('onlineUpiAmount', '1'), sameUnit]),
      cnf('Online — reference matches bank (other unit)', 'FORCE_MATCHED_OTHER_UNIT', [notUpi, refGroup('transId', 'transactionRef2'), amount('onlineUpiAmount', '1')]),
      cnf('UPI — reference in bank ref / narration (same unit)', 'FORCE_MATCHED_SAME_UNIT', [isUpi, refGroup('transId', 'transactionRef2'), amount('onlineUpiAmount', '1'), sameUnit]),
      cnf('UPI — reference in bank ref / narration (other unit)', 'FORCE_MATCHED_OTHER_UNIT', [isUpi, refGroup('transId', 'transactionRef2'), amount('onlineUpiAmount', '1')]),
      // Shapes not in the live set.
      cnf('Receipt in narration within 3 days', 'FORCE_MATCHED', [[pair('receiptNumber', 'CONTAINS', 'narration')], [pair('receiptDate', 'DATE_WITHIN_DAYS', 'txnDate', { pairTolerance: '3' })]]),
      cnf('Same-day exact', 'FORCE_MATCHED', [[pair('transId', 'EQUALS', 'chqRefNo')], [pair('receiptDate', 'DATE_WITHIN_DAYS', 'txnDate', { pairTolerance: '0' })], amount('billAmount', '0')]),
      cnf('Exclude staff', 'EXCLUDE', [[literal('patType', 'EQUALS', 'STAFF')], [pair('transId', 'EQUALS', 'chqRefNo')]]),
      cnf('Force unmatched outside unit', 'FORCE_UNMATCHED', [[pair('transId', 'CONTAINS', 'narration')], [pair('division', 'EQUALS', 'divisionName', { negate: true })]]),
      cnf('Mismatch big gap', 'FORCE_MISMATCH', [[pair('transId', 'EQUALS', 'chqRefNo')], [pair('onlineUpiAmount', 'AMOUNT_WITHIN_TOLERANCE', 'depositAmt', { pairTolerance: '1', negate: true })]]),
      cnf('Two references', 'FORCE_MATCHED_TOL_OTHER_UNIT', [[pair('transId', 'EQUALS', 'chqRefNo')], [pair('ipNo', 'CONTAINS', 'narration')], amount('billAmount', '250')]),
      unit('Bank to MIS exact', { direction: 'BANK_TO_MIS' }),
      unit('Base, narration only', { unitKeyMode: 'BASE', bankRefField: 'narration', useNarration: false, tolerance: 1 }),
      unit('Bank to MIS, any unit, affix', { direction: 'BANK_TO_MIS', scope: 'NONE', unitKeyMode: 'AFFIX' }),
      unit('Receipt keyed', { paymentRefField: 'receiptNumber', useNarration: false }),
    ],
  },
  {
    stream: 'DIAG',
    rules: [
      cnf('Online — reference matches bank (same unit)', 'FORCE_MATCHED_SAME_UNIT', [notUpi, refGroup('transactionRef1', 'transactionRef2'), amount('onlineUpiAmount', '1'), sameUnit]),
      cnf('UPI — reference in bank ref / narration (other unit)', 'FORCE_MATCHED_OTHER_UNIT', [isUpi, refGroup('transactionRef1', 'transactionRef2'), amount('onlineUpiAmount', '1')]),
      unit('Transaction Amount Match on Same Unit', { tolerance: 1, unitKeyMode: 'AFFIX' }),
      cnf('International — receipt drawn from inward remittance', 'FORCE_MATCHED_OTHER_UNIT', [
        [literal('patType', 'CONTAINS', 'INT')],
        [pair('transId', 'CONTAINS', 'narration'), pair('transId', 'EQUALS', 'chqRefNo'), pair('transactionRef1', 'CONTAINS', 'narration'), pair('transactionRef1', 'EQUALS', 'chqRefNo')],
        amount('billAmount', '1'),
      ]),
      unit('Transaction Amount Match on Other Units', { scope: 'NONE', unitKeyMode: 'AFFIX' }),
    ],
  },
  {
    stream: 'CHEQUE',
    rules: [
      cnf('Cheque number matches bank statement', 'FORCE_MATCHED', [[pair('chequeNo', 'EQUALS', 'chqRefNo'), pair('chequeNo', 'CONTAINS', 'narration')], amount('chequeAmount', '1')]),
      // Saved 2026-09-28 for cheque 127760 (10 receipts, one ₹17,355 credit).
      unit('Receipts sharing one cheque (same unit)', { paymentRefField: 'chequeNo', tolerance: 1, useNarration: false }),
      contra('Contra entry against refund document', {}),
      contra('Contra entry - cheque number and amount', { keyFields: ['chequeNo'] }),
      contra('Contra, same unit, 5 days, bill amount', { scope: 'DIVISION', dateWindowDays: 5, amountField: 'billAmount', tolerance: 10, keyFields: ['chequeNo', 'patientName'], onAmbiguous: 'AMBIGUOUS_MATCH' }),
      cnf('Cheque by TPA code', 'FORCE_MATCHED', [[literal('paymentMode', 'EQUALS', 'MEDIASSIST')], [pair('chequeNo', 'EQUALS', 'chqRefNo')]]),
      // On cheques "Payment Mode" IS the Pay Type column — these three prove the example treats them as one.
      cnf('Cheque by Pay Type', 'FORCE_MATCHED', [[literal('payType', 'EQUALS', 'MEDIASSIST')], [pair('chequeNo', 'EQUALS', 'chqRefNo')]]),
      cnf('Mode and Pay Type agree', 'FORCE_MATCHED', [
        [literal('paymentMode', 'CONTAINS', 'TPA')],
        [literal('payType', 'EQUALS', 'TPA-MEDIASSIST')],
        [pair('chequeNo', 'EQUALS', 'chqRefNo')],
      ]),
    ],
  },
];

function gateway(target: GatewayTarget, gatewayConfig: Partial<GatewayRuleConfig>, id = String(nextId++)): GatewayRule {
  return { id, name: `${target} policy`, target, active: true, sortOrder: 1, gatewayConfig: gatewayConfig as GatewayRuleConfig, createdAt: '', updatedAt: '' };
}

const GATEWAY_RULES: GatewayRule[] = [
  // As stored — onGroupMismatch absent, so the default applies.
  gateway('CARD', { tolerance: 1, onAmbiguous: 'NEAREST_AMOUNT' }),
  gateway('CARD', { tolerance: 1, onAmbiguous: 'UNMATCHED', onGroupMismatch: 'REPORT_DIFFERENCE' }),
  gateway('UPI', { tolerance: 1, onAmbiguous: 'NEAREST_AMOUNT', excludeRefundPairs: true }),
  gateway('UPI', { tolerance: 0, onAmbiguous: 'UNMATCHED', excludeRefundPairs: false }),
  gateway('PAYU', { tolerance: 1, onAmbiguous: 'NEAREST_AMOUNT', compareAmount: 'NET', minTokenLength: 8, useNarrationTokens: true }),
  gateway('PAYU', { tolerance: 0, compareAmount: 'GROSS', useNarrationTokens: false }),
  gateway('EASEBUZZ', { tolerance: 1, onAmbiguous: 'NEAREST_AMOUNT', minTokenLength: 8, useNarrationTokens: true }),
  gateway('EASEBUZZ', { tolerance: 0, useNarrationTokens: false }),
];

// --- running an example through the backend ----------------------------------

function backendVerdict(example: RuleExample): Record<string, string> {
  const { engine, input } = example.verification;
  const i = input as AnyRow;
  switch (engine) {
    case 'CNF': {
      const group = { first: i['payment'] };
      // Each check the panel shows must agree with the engine on that one step.
      for (const check of example.checks) {
        expect(rulesEngine.groupsMatch([i['groups'][check.step - 1]], group, i['bank'], i['paymentModeField'])).toBe(check.ok);
      }
      return { rule: rulesEngine.groupsMatch(i['groups'], group, i['bank'], i['paymentModeField']) ? 'MATCH' : 'NO_MATCH' };
    }
    case 'UNIT':
    case 'CONTRA': {
      const records: AnyRow[] = i['records'];
      const groupResults = records.map((r) => ({ sourceRecordIds: [String(r['id'])], status: 'UNMATCHED', excluded: false, bank: null }));
      const { patches } =
        engine === 'UNIT'
          ? unitPass.runUnitPass({ groupResults, records, bankRecords: i['bankRecords'], rule: i['rule'] })
          : contraPass.runContraPass({ groupResults, records, refundRecords: i['refundRecords'], rule: i['rule'] });
      return Object.fromEntries(records.map((r) => [String(r['id']), patches.get(String(r['id']))?.status ?? 'UNMATCHED']));
    }
    case 'CARD':
      return Object.fromEntries(cardMatcher.reconcileCardTransactions(i).map((r: AnyRow) => [String(r['misRecordId']), r['status']]));
    case 'UPI':
      return Object.fromEntries(upiMatcher.reconcileUpiTransactions(i).map((r: AnyRow) => [String(r['misRecordId']), r['status']]));
    case 'PAYU':
      return Object.fromEntries(payuSettlement.reconcilePayuSettlements(i).map((r: AnyRow) => [String(r['settlementUtr']), r['status']]));
    case 'EASEBUZZ':
      return Object.fromEntries(easebuzzSettlement.reconcileEasebuzzSettlements(i).map((r: AnyRow) => [String(r['settlementId']), r['status']]));
  }
}

/** Nothing a reader sees may contain a JavaScript artefact. */
function expectCleanText(explanation: RuleExplanation): void {
  const shown = JSON.stringify({ ...explanation, examples: explanation.examples.map(({ verification: _v, ...rest }) => rest) });
  expect(shown).not.toMatch(/undefined|NaN|\[object|null/);
}

describe('Rule details explanations', () => {
  for (const { stream, rules } of RULE_SETS) {
    for (const rule of rules) {
      it(`${stream} · ${rule.name}: every example gets the verdict it shows from the backend engine`, () => {
        const explanation = explainMatchingRule(rule, stream, rules);
        expect(explanation.warnings).toEqual([]);
        expect(explanation.examples.length).toBe(2);
        expectCleanText(explanation);
        for (const example of explanation.examples) {
          expect(backendVerdict(example)).toEqual(example.verification.expected);
        }
      });
    }
  }

  it('a condition rule example passes every check, and its counter-example fails exactly one', () => {
    for (const { stream, rules } of RULE_SETS) {
      for (const rule of rules.filter((r) => r.kind === 'CNF')) {
        const [match, miss] = explainMatchingRule(rule, stream, rules).examples;
        expect(match.checks.every((c) => c.ok)).toBe(true);
        expect(miss.checks.filter((c) => !c.ok).length).toBe(1);
      }
    }
  });

  it('says a same-unit total rule listed above condition rules still runs after them', () => {
    const ip = RULE_SETS[0].rules;
    expect(explainMatchingRule(ip[0], 'IP', ip).runOrder.join(' ')).toContain('does not make it run before them');
  });

  it('warns about a rule that can never match, instead of showing a false example', () => {
    const contradiction = cnf('Impossible', 'FORCE_MATCHED', [isUpi, notUpi, [pair('transId', 'EQUALS', 'chqRefNo')]]);
    const explanation = explainMatchingRule(contradiction, 'IP', [contradiction]);
    expect(explanation.examples).toEqual([]);
    expect(explanation.warnings.join(' ')).toContain('contradict');
  });

  it("warns that a 'Same upload batch' total rule matches nothing, and shows no example", () => {
    const batch = unit('Same batch', { scope: 'BATCH' });
    const explanation = explainMatchingRule(batch, 'IP', [batch]);
    expect(explanation.examples).toEqual([]);
    expect(explanation.warnings.join(' ')).toContain('matches nothing');

    // The claim itself, against the engine: two same-batch rows and a bank credit that should total them.
    const records = [
      { id: '1', transactionRef1: 'SBIN0426072936976', division: 'Somajiguda', batchId: '12', billAmount: 150000 },
      { id: '2', transactionRef1: 'SBIN0426072936976', division: 'Somajiguda', batchId: '12', billAmount: 150000 },
    ];
    const bankRecords = [{ id: 'b1', chqRefNo: 'SBIN0426072936976', narration: '', divisionName: 'Somajiguda', depositAmt: 300000 }];
    const groupResults = records.map((r) => ({ sourceRecordIds: [r.id], status: 'UNMATCHED', excluded: false, bank: null }));
    const { patches } = unitPass.runUnitPass({ groupResults, records, bankRecords, rule: { name: 'Same batch', ...batch.unitConfig } });
    expect(patches.size).toBe(0);
  });

  it('on cheques, a Payment Mode and a Pay Type condition that disagree are reported as contradictory', () => {
    // The engine reads both from the same Pay Type column, so this rule can never match.
    const clash = cnf('Clash', 'FORCE_MATCHED', [
      [literal('paymentMode', 'EQUALS', 'CHEQUE')],
      [literal('payType', 'EQUALS', 'MEDIASSIST')],
      [pair('chequeNo', 'EQUALS', 'chqRefNo')],
    ]);
    expect(explainMatchingRule(clash, 'CHEQUE', [clash]).warnings.join(' ')).toContain('contradict');
    // …while on IP they are two different columns, so the same rule is fine.
    expect(explainMatchingRule(clash, 'IP', [clash]).warnings).toEqual([]);
  });

  it('warns about a rule the engine skips for having no reference check', () => {
    const unindexed = cnf('Amount only', 'FORCE_MATCHED', [amount('billAmount', '1')]);
    expect(explainMatchingRule(unindexed, 'IP', [unindexed]).warnings.join(' ')).toContain('skips it');
  });

  for (const rule of GATEWAY_RULES) {
    it(`gateway · ${rule.target} ${JSON.stringify(rule.gatewayConfig)}: examples agree with the backend matcher`, () => {
      const explanation = explainGatewayRule(rule, rule.id);
      expect(explanation.examples.length).toBe(2);
      expectCleanText(explanation);
      for (const example of explanation.examples) {
        expect(backendVerdict(example)).toEqual(example.verification.expected);
      }
    });
  }
});
