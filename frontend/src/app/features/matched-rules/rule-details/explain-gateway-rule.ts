import {
  GATEWAY_TARGET_OPTIONS,
  GatewayRule,
  GatewayRuleConfig,
  GatewayTarget,
  defaultGatewayConfig,
} from '../../../core/models/gateway-rules.model';
import { formatDay, inr } from './explain-format';
import { ExplainStep, ExplainTone, RuleExample, RuleExplanation } from './rule-explanation.model';

/**
 * Explains a Card / UPI / PayU / EaseBuzz matching policy in plain language,
 * with worked examples. These four matchers join on file-format facts that are
 * not configurable (card approval code, UPI RRN, PayU settlement UTR, EaseBuzz
 * bank id), so the "which field" part of each explanation is fixed per target;
 * only the policy knobs vary. Mirrors card-matcher.js, upi-matcher.js,
 * payu-settlement.js and easebuzz-settlement.js — rule-explainer.spec.ts runs
 * every example through them.
 */

const within = (tol: number) => (tol > 0 ? `, within ${inr(tol)}` : ' exactly');

function ambiguitySentence(cfg: GatewayRuleConfig, what: string): string {
  return cfg.onAmbiguous === 'UNMATCHED' ? `the ${what} is left Unmatched — no guessing.` : 'the one nearest in amount is taken.';
}

function collisionStep(cfg: GatewayRuleConfig, code: string): ExplainStep {
  return {
    title: `If receipts sharing one ${code} do not add up`,
    detail:
      cfg.onGroupMismatch === 'REPORT_DIFFERENCE'
        ? `Every receipt in the group is marked Amount Mismatch with the group's difference.`
        : `An ${code} can be reused, so unrelated receipts sometimes share one. The single receipt that matches a settlement line on its own is Matched; the others are Unmatched, with the shared ${code} named. If no single receipt matches, all of them are Unmatched.`,
  };
}

// --- Card -------------------------------------------------------------------

function cardExplanation(cfg: GatewayRuleConfig): Pick<RuleExplanation, 'summary' | 'steps' | 'outcomes' | 'examples'> {
  const tol = Number(cfg.tolerance) || 0;
  const steps: ExplainStep[] = [
    {
      title: 'Card receipts with the same approval code are added together',
      detail: 'One card payment is sometimes split across several receipts. Leading zeros in the code are ignored.',
    },
    { title: 'The approval code is looked up in the Card MPR and Pine Labs settlement files' },
    { title: `The receipts' total must equal the settlement amount${within(tol)}` },
    {
      title: 'If the code is on more than one settlement line',
      detail: `If those lines together equal the total, they are all taken. Otherwise ${ambiguitySentence(cfg, 'receipt')}`,
    },
    collisionStep(cfg, 'approval code'),
  ];

  const split: RuleExample = {
    title: 'Example — one payment split over two receipts',
    tables: [
      {
        heading: 'MIS rows (card receipts)',
        columns: ['Receipt Number', 'Approval Code', 'Amount'],
        rows: [
          ['DFV1009115', '328243', inr(100)],
          ['DFV1009116', '328243', inr(1600)],
        ],
      },
      { heading: 'Card MPR line', columns: ['App Code', 'Process Date', 'Amount'], rows: [['328243', formatDay('2026-08-14'), inr(1700)]] },
    ],
    checks: [
      { step: 1, ok: true, detail: `Both receipts carry 328243 — ${inr(100)} + ${inr(1600)} = ${inr(1700)}` },
      { step: 2, ok: true, detail: 'Code 328243 is on one Card MPR line' },
      { step: 3, ok: true, detail: `${inr(1700)} vs ${inr(1700)} — difference ${inr(0)}` },
    ],
    result: 'Both receipts are marked Grouped Matched — together they are the one card payment.',
    resultTone: 'success',
    verification: {
      engine: 'CARD',
      input: {
        misRows: [
          { id: '1', instrumentType: 'CARD', referenceId: '328243', amount: 100 },
          { id: '2', instrumentType: 'CARD', referenceId: '328243', amount: 1600 },
        ],
        cardMprRows: [{ id: 'm1', appCode: '328243', pymtChgamnt: 1700, processDate: '2026-08-14' }],
        pinelabsRows: [],
        policy: cfg,
      },
      expected: { '1': 'GROUPED_MATCHED', '2': 'GROUPED_MATCHED' },
    },
  };

  const preferExact = cfg.onGroupMismatch !== 'REPORT_DIFFERENCE';
  const reused: RuleExample = {
    title: 'Example — a reused code joins two unrelated receipts',
    tables: [
      {
        heading: 'MIS rows (card receipts)',
        columns: ['Receipt Number', 'Approval Code', 'Amount'],
        rows: [
          ['IPR24518', '004360', inr(50000)],
          ['DFV1022871', '004360', inr(800)],
        ],
      },
      { heading: 'Card MPR line', columns: ['App Code', 'Process Date', 'Amount'], rows: [['004360', formatDay('2026-09-07'), inr(50000)]] },
    ],
    checks: [
      { step: 1, ok: true, detail: `Both receipts carry 004360 — ${inr(50000)} + ${inr(800)} = ${inr(50800)}` },
      { step: 2, ok: true, detail: 'Code 004360 is on one Card MPR line' },
      { step: 3, ok: false, detail: `${inr(50800)} vs ${inr(50000)} — difference ${inr(800)}` },
      {
        step: 5,
        ok: preferExact,
        detail: preferExact
          ? `Receipt IPR24518 (${inr(50000)}) matches the settlement line on its own`
          : `The whole group is reported with the ${inr(800)} difference`,
      },
    ],
    result: preferExact
      ? 'IPR24518 is marked Matched. DFV1022871 is marked Unmatched — it only shares the reused code.'
      : `Both receipts are marked Amount Mismatch, each showing the group's ${inr(800)} difference.`,
    resultTone: preferExact ? 'neutral' : 'danger',
    verification: {
      engine: 'CARD',
      input: {
        misRows: [
          { id: '1', instrumentType: 'CARD', referenceId: '004360', amount: 50000 },
          { id: '2', instrumentType: 'CARD', referenceId: '004360', amount: 800 },
        ],
        cardMprRows: [{ id: 'm1', appCode: '004360', pymtChgamnt: 50000, processDate: '2026-09-07' }],
        pinelabsRows: [],
        policy: cfg,
      },
      expected: preferExact ? { '1': 'MATCHED', '2': 'UNMATCHED' } : { '1': 'AMOUNT_MISMATCH', '2': 'AMOUNT_MISMATCH' },
    },
  };

  return {
    summary:
      "Card receipts in the MIS are matched with the card processor's settlement files (Card MPR or Pine Labs) using the approval code, and the amounts are compared.",
    steps,
    outcomes: [
      { when: 'One receipt, amount agrees', status: 'Matched', tone: 'success' },
      { when: 'Several receipts together agree', status: 'Grouped Matched', tone: 'success' },
      { when: 'The code is found but the amount differs', status: 'Amount Mismatch', tone: 'danger' },
      { when: 'The code is not in any settlement file', status: 'Unmatched', tone: 'danger' },
    ],
    examples: [split, reused],
  };
}

// --- UPI --------------------------------------------------------------------

function upiExplanation(cfg: GatewayRuleConfig): Pick<RuleExplanation, 'summary' | 'steps' | 'outcomes' | 'examples'> {
  const tol = Number(cfg.tolerance) || 0;
  const steps: ExplainStep[] = [
    {
      title: 'UPI receipts with the same RRN are added together',
      detail: 'One UPI payment is sometimes split across several receipts. Leading zeros are ignored.',
    },
    { title: 'The RRN is looked up in the UPI MPR' },
    cfg.excludeRefundPairs === false
      ? {
          title: 'Refunded payments are kept in the MPR',
          detail: 'A payment that was credited and then paid back can still match a receipt.',
        }
      : {
          title: 'Payments that were credited and then refunded are left out',
          detail:
            'A failed UPI payment shows in the MPR twice — once credited, once paid back, under the same order ID. Both lines are ignored, since the hospital never kept the money.',
        },
    { title: `The receipts' total must equal the MPR amount${within(tol)}` },
    { title: 'If the RRN is on more than one MPR line', detail: `If those lines together equal the total, they are all taken. Otherwise ${ambiguitySentence(cfg, 'receipt')}` },
    collisionStep(cfg, 'RRN'),
  ];

  const example = (mprAmount: number): RuleExample => {
    const ok = Math.abs(mprAmount - 1200) <= tol;
    return {
      title: ok ? 'Example — the amounts agree' : 'Example — the amounts differ',
      tables: [
        { heading: 'MIS row (UPI receipt)', columns: ['Receipt Number', 'RRN', 'Amount'], rows: [['DFV1009120', '265715574810', inr(1200)]] },
        {
          heading: 'UPI MPR line',
          columns: ['RRN', 'Order ID', 'Cr/Dr', 'Settlement Date', 'Amount'],
          rows: [['265715574810', 'ORD771204', 'CR', formatDay('2026-08-14'), inr(mprAmount)]],
        },
      ],
      checks: [
        { step: 1, ok: true, detail: 'One receipt carries RRN 265715574810' },
        { step: 2, ok: true, detail: 'RRN 265715574810 is on one UPI MPR line' },
        { step: 4, ok, detail: `${inr(1200)} vs ${inr(mprAmount)} — difference ${inr(Math.abs(1200 - mprAmount))}` },
      ],
      result: ok ? 'The receipt is marked Matched.' : `The receipt is marked Amount Mismatch (${inr(Math.abs(1200 - mprAmount))}).`,
      resultTone: ok ? 'success' : 'danger',
      verification: {
        engine: 'UPI',
        input: {
          misRows: [{ id: '1', instrumentType: 'UPI', referenceId: '265715574810', amount: 1200 }],
          upiMprRows: [{ id: 'u1', rrn: '265715574810', orderId: 'ORD771204', crDr: 'CR', transactionAmount: mprAmount, settlementDate: '2026-08-14' }],
          policy: cfg,
        },
        expected: { '1': ok ? 'MATCHED' : 'AMOUNT_MISMATCH' },
      },
    };
  };

  return {
    summary: 'UPI receipts in the MIS are matched with the UPI MPR using the RRN, and the amounts are compared.',
    steps,
    outcomes: [
      { when: 'One receipt, amount agrees', status: 'Matched', tone: 'success' },
      { when: 'Several receipts together agree', status: 'Grouped Matched', tone: 'success' },
      { when: 'The RRN is found but the amount differs', status: 'Amount Mismatch', tone: 'danger' },
      { when: 'The RRN is not in the MPR', status: 'Unmatched', tone: 'danger' },
    ],
    examples: [example(1200), example(1150)],
  };
}

// --- PayU / EaseBuzz ----------------------------------------------------------

function bankLookupStep(cfg: GatewayRuleConfig, ref: string): ExplainStep {
  const min = Number(cfg.minTokenLength) || 8;
  if (cfg.useNarrationTokens === false) return { title: `The bank credit is found by the ${ref} in its Chq/Ref No.` };
  return {
    title: `The bank credit is found by the ${ref} in its Chq/Ref No., or as a word of at least ${min} characters in its Narration`,
    detail: `Shorter words are never used — below 8 characters, ordinary words like PAYMENT or SETTLED would start counting as references.`,
  };
}

const PAYU_UTR = 'UTIBR72026072700057634';
const PAYU_NARRATION = `RTGS CR-UTIB0003156-PAYU PAYMENTS PVT LTD-YASHODA-${PAYU_UTR}`;
const PAYU_LINES = [
  { id: 'p1', gross: 10000, net: 9800 },
  { id: 'p2', gross: 5000, net: 4900 },
  { id: 'p3', gross: 2000, net: 1960 },
];

function payuExplanation(cfg: GatewayRuleConfig): Pick<RuleExplanation, 'summary' | 'steps' | 'outcomes' | 'examples'> {
  const tol = Number(cfg.tolerance) || 0;
  const gross = cfg.compareAmount === 'GROSS';
  const steps: ExplainStep[] = [
    { title: 'PayU MPR lines are grouped by their settlement UTR', detail: 'PayU pays many UPI payments out as one bank credit, quoting one UTR.' },
    { title: gross ? "Their gross amounts (before PayU's fee) are added up" : "Their net amounts (after PayU's fee) are added up" },
    bankLookupStep(cfg, 'UTR'),
    { title: `The total must equal the bank credit${within(tol)}` },
    { title: 'If more than one bank credit carries the UTR', detail: `Then ${ambiguitySentence(cfg, 'settlement')}` },
  ];

  const total = PAYU_LINES.reduce((s, l) => s + (gross ? l.gross : l.net), 0);
  const example = (bankAmount: number): RuleExample => {
    const ok = Math.abs(bankAmount - total) <= tol;
    // Without narration words the UTR has to be in Chq/Ref No., or nothing is found.
    const chqRefNo = cfg.useNarrationTokens === false ? PAYU_UTR : '';
    return {
      title: ok ? 'Example — the payout matches' : 'Example — the payout is short',
      tables: [
        {
          heading: 'PayU MPR lines',
          columns: ['Settlement UTR', 'Gross Amount', 'Net Amount'],
          rows: PAYU_LINES.map((l) => [PAYU_UTR, inr(l.gross), inr(l.net)]),
        },
        {
          heading: 'Bank statement line',
          columns: ['Transaction Date', 'Chq/Ref No.', 'Narration', 'Deposit Amount'],
          rows: [[formatDay('2026-07-27'), chqRefNo || '—', PAYU_NARRATION, inr(bankAmount)]],
        },
      ],
      checks: [
        { step: 1, ok: true, detail: `3 MPR lines share UTR ${PAYU_UTR}` },
        {
          step: 2,
          ok: true,
          detail: `${PAYU_LINES.map((l) => inr(gross ? l.gross : l.net)).join(' + ')} = ${inr(total)} (${gross ? 'gross' : 'net'})`,
        },
        { step: 3, ok: true, detail: chqRefNo ? 'The UTR is the bank line’s Chq/Ref No.' : 'The UTR is the last word of the bank narration' },
        { step: 4, ok, detail: `${inr(total)} vs ${inr(bankAmount)} — difference ${inr(Math.abs(total - bankAmount))}` },
      ],
      result: ok ? 'The settlement is marked Matched.' : `The settlement is marked Amount Mismatch (${inr(Math.abs(total - bankAmount))}).`,
      resultTone: ok ? 'success' : 'danger',
      verification: {
        engine: 'PAYU',
        input: {
          mprRows: PAYU_LINES.map((l) => ({ id: l.id, settlementUtr: PAYU_UTR, depositAmt: l.gross, netAmount: l.net })),
          bankRows: [{ id: 'b1', txnDate: '2026-07-27', chqRefNo, narration: PAYU_NARRATION, depositAmt: bankAmount }],
          policy: cfg,
        },
        expected: { [PAYU_UTR]: ok ? 'MATCHED' : 'AMOUNT_MISMATCH' },
      },
    };
  };

  return {
    summary: 'PayU pays out many UPI payments as one bank credit. The MPR lines of one payout are added up and compared with the bank credit that carries the same UTR.',
    steps,
    outcomes: [
      { when: 'The bank credit agrees', status: 'Matched', tone: 'success' },
      { when: 'Found, but the amount differs', status: 'Amount Mismatch', tone: 'danger' },
      { when: 'No bank credit carries the UTR', status: 'Unmatched', tone: 'danger' },
    ],
    examples: [example(total), example(total - 160)],
  };
}

function easebuzzExplanation(cfg: GatewayRuleConfig): Pick<RuleExplanation, 'summary' | 'steps' | 'outcomes' | 'examples'> {
  const tol = Number(cfg.tolerance) || 0;
  const steps: ExplainStep[] = [
    { title: 'Each EaseBuzz settlement row is matched on its own', detail: 'The EaseBuzz report already has one row per payout, so nothing is added up.' },
    bankLookupStep(cfg, "settlement's Bank ID"),
    { title: `The settled amount must equal the bank credit${within(tol)}` },
    { title: 'If more than one bank credit carries the Bank ID', detail: `Then ${ambiguitySentence(cfg, 'settlement')}` },
  ];

  const settled = 520001;
  const bankId = 'AXISCN0412345678';
  const example = (bankAmount: number): RuleExample => {
    const ok = Math.abs(bankAmount - settled) <= tol;
    return {
      title: ok ? 'Example — the payout matches' : 'Example — the payout differs',
      tables: [
        {
          heading: 'EaseBuzz settlement row',
          columns: ['Settlement ID', 'Bank ID', 'Settlement Date', 'Settled Amount'],
          rows: [['EBZ88213', bankId, formatDay('2026-08-14'), inr(settled)]],
        },
        {
          heading: 'Bank statement line',
          columns: ['Transaction Date', 'Chq/Ref No.', 'Narration', 'Deposit Amount'],
          rows: [[formatDay('2026-08-14'), bankId, 'NEFT CR-EASEBUZZ PVT LTD-YASHODA HOSPITALS', inr(bankAmount)]],
        },
      ],
      checks: [
        { step: 2, ok: true, detail: `Bank ID ${bankId} is the bank line's Chq/Ref No.` },
        { step: 3, ok, detail: `${inr(settled)} vs ${inr(bankAmount)} — difference ${inr(Math.abs(settled - bankAmount))}` },
      ],
      result: ok ? 'The settlement is marked Matched.' : `The settlement is marked Amount Mismatch (${inr(Math.abs(settled - bankAmount))}).`,
      resultTone: ok ? 'success' : 'danger',
      verification: {
        engine: 'EASEBUZZ',
        input: {
          settlementRows: [{ settlementId: 'EBZ88213', bankId, totalAmount: 520500, settledAmount: settled, settlementDate: '2026-08-14' }],
          bankRows: [{ id: 'b1', txnDate: '2026-08-14', chqRefNo: bankId, narration: 'NEFT CR-EASEBUZZ PVT LTD-YASHODA HOSPITALS', depositAmt: bankAmount }],
          policy: cfg,
        },
        expected: { EBZ88213: ok ? 'MATCHED' : 'AMOUNT_MISMATCH' },
      },
    };
  };

  return {
    summary: 'Each EaseBuzz payout is matched with the bank credit that carries its Bank ID, and the settled amount is compared.',
    steps,
    outcomes: [
      { when: 'The bank credit agrees', status: 'Matched', tone: 'success' },
      { when: 'Found, but the amount differs', status: 'Amount Mismatch', tone: 'danger' },
      { when: 'No bank credit carries the Bank ID', status: 'Unmatched', tone: 'danger' },
    ],
    examples: [example(settled), example(519500)],
  };
}

const BUILDERS: Record<GatewayTarget, (cfg: GatewayRuleConfig) => Pick<RuleExplanation, 'summary' | 'steps' | 'outcomes' | 'examples'>> = {
  CARD: cardExplanation,
  UPI: upiExplanation,
  PAYU: payuExplanation,
  EASEBUZZ: easebuzzExplanation,
};

/**
 * @param rule        the policy to explain
 * @param effectiveId the id of the policy currently "In effect" for this target, if any
 */
export function explainGatewayRule(rule: GatewayRule, effectiveId: string | null): RuleExplanation {
  // A stored policy may predate a knob; the matcher fills it from the defaults, so the explanation does too.
  const cfg: GatewayRuleConfig = { ...defaultGatewayConfig(rule.target), ...(rule.gatewayConfig ?? {}) };
  const targetLabel = GATEWAY_TARGET_OPTIONS.find((o) => o.value === rule.target)?.label ?? rule.target;
  const inEffect = rule.id === effectiveId;
  const warnings: string[] = [];
  if (!rule.active) warnings.push('This policy is switched off (Inactive), so it is not used.');
  else if (!inEffect) warnings.push('This policy is not in effect — an Active policy above it in the list is used instead.');

  return {
    name: rule.name,
    kindLabel: `${targetLabel} policy`,
    active: rule.active,
    outcome: { label: inEffect ? 'In effect' : 'Not in effect', tone: (inEffect ? 'success' : 'neutral') as ExplainTone },
    stepsHeading: 'How it works',
    ...BUILDERS[rule.target](cfg),
    runOrder: [
      `Only one policy is used for ${targetLabel}: the first Active one in the list, marked "In effect". Others are kept but not used.`,
      'It is applied every time this reconciliation is generated.',
    ],
    warnings,
  };
}
