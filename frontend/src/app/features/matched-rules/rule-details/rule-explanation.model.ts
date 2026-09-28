/**
 * The plain-language "Rule details" view of one matching rule: what it does,
 * each check spelled out, and a worked example built from the rule itself.
 *
 * Every rule screen (IP, Diagnostics, Cheque, Gateway) produces one of these
 * and hands it to <app-rule-details>, which only renders it. Keeping the
 * wording here, not in four templates, is what keeps the four explanations
 * consistent with each other.
 */

/** Green = a matched verdict, red = anything else — the client's own convention (status-tone.js). */
export type ExplainTone = 'success' | 'danger' | 'neutral';

export interface ExplainStep {
  /** One sentence. For an OR-group, the lead-in ("At least one of these:"). */
  title: string;
  /** The alternatives of an OR-group, one sentence each. */
  options?: string[];
  /** How the comparison is made — what is ignored, what is allowed. */
  detail?: string;
}

export interface ExampleTable {
  heading: string;
  columns: string[];
  rows: string[][];
}

export interface ExampleCheck {
  /** 1-based step number this check answers. */
  step: number;
  ok: boolean;
  detail: string;
}

/**
 * What the real backend engine is fed and must conclude for this example.
 * Not shown on screen — rule-explainer.spec.ts runs it through the backend
 * matchers, so an example can never claim a verdict the engine would not give.
 */
export interface ExampleVerification {
  engine: 'CNF' | 'UNIT' | 'CONTRA' | 'CARD' | 'UPI' | 'PAYU' | 'EASEBUZZ';
  input: Record<string, unknown>;
  /** Expected status per record id (MIS row, collection, settlement or UTR). */
  expected: Record<string, string>;
}

export interface RuleExample {
  title: string;
  tables: ExampleTable[];
  checks: ExampleCheck[];
  /** Something the example shows that no check spells out ("the units differ — allowed"). */
  note?: string;
  result: string;
  resultTone: ExplainTone;
  verification: ExampleVerification;
}

export interface RuleExplanation {
  name: string;
  kindLabel: string;
  active: boolean;
  /** What a hit does — "Marks it Matched". */
  outcome: { label: string; tone: ExplainTone };
  summary: string;
  stepsHeading: string;
  steps: ExplainStep[];
  /** Possible verdicts, for rules that can end in more than one ("Total equal → Matched"). */
  outcomes: { when: string; status: string; tone: ExplainTone }[];
  runOrder: string[];
  examples: RuleExample[];
  warnings: string[];
}
