import { z } from 'zod';

import {
  AGENCY_IMITATION_PATTERNS,
  OriginalityRiskLevelSchema,
  type CreativeDivergenceRecord,
  type CreativeMemoryAgentRole,
  type CreativeMemoryContext,
  type OriginalityRiskLevel,
} from './creative-memory-injection';
import { AGENT_SAFE_FORBIDDEN_VALUE_PATTERNS } from './creative-memory-retrieval';

/**
 * A deterministic originality check over what the agents actually produced.
 *
 * **This is a governance signal, not copyright detection.** It cannot tell you
 * whether a campaign infringes anything; it can tell you that a plan reproduced
 * eight consecutive words from a reference's craft note, or reproduced a
 * reference's beat sequence exactly, or contains an instruction to imitate an
 * agency. Those are the failure modes injecting benchmark intelligence
 * introduces, and each of them is decidable from the structured outputs without
 * a model, a clock or a network call.
 *
 * The agent's own `originalityRiskLevel` is an input, never the answer: the
 * evaluator may raise the level it declared and will never lower it.
 */

export const ORIGINALITY_SIGNAL_CODES = [
  /** Eight or more consecutive words lifted from a reference's craft note. */
  'COPIED_REFERENCE_PHRASE',
  /** The planned beat lengths reproduce a reference's scene sequence exactly. */
  'IDENTICAL_BEAT_SEQUENCE',
  /** The plan leans on one reference while the context offered alternatives. */
  'SINGLE_SOURCE_DEPENDENCE',
  /** An output tells a downstream stage to imitate a named agency, studio or campaign. */
  'NAMED_AGENCY_IMITATION',
  /** An output carries a path, URL or media filename — expressive material escaping. */
  'FORBIDDEN_FIELD_IN_OUTPUT',
  /** Context was injected but the agent returned no divergence record. */
  'MISSING_DIVERGENCE_RECORD',
  /** The divergence record cites a reference that was not in the agent's context. */
  'UNKNOWN_REFERENCE_CITED',
  /** The agent assessed its own output as high risk. Taken at its word. */
  'AGENT_DECLARED_HIGH_RISK',
] as const;
export const OriginalitySignalCodeSchema = z.enum(ORIGINALITY_SIGNAL_CODES);
export type OriginalitySignalCode = z.infer<typeof OriginalitySignalCodeSchema>;

/**
 * How severe each signal is.
 *
 * `HIGH` blocks production planning. `MEDIUM` is recorded and routed to a
 * human. The split is deliberate and conservative in both directions: verbatim
 * reuse, a replayed beat sequence, an imitation instruction and leaked
 * expressive material are the things that must not reach a render, while
 * leaning on one source or forgetting a divergence record are process problems
 * a reviewer should see rather than reasons to throw a campaign away.
 */
export const ORIGINALITY_SIGNAL_SEVERITY: Readonly<
  Record<OriginalitySignalCode, Exclude<OriginalityRiskLevel, 'LOW'>>
> = {
  COPIED_REFERENCE_PHRASE: 'HIGH',
  IDENTICAL_BEAT_SEQUENCE: 'HIGH',
  NAMED_AGENCY_IMITATION: 'HIGH',
  FORBIDDEN_FIELD_IN_OUTPUT: 'HIGH',
  AGENT_DECLARED_HIGH_RISK: 'HIGH',
  SINGLE_SOURCE_DEPENDENCE: 'MEDIUM',
  MISSING_DIVERGENCE_RECORD: 'MEDIUM',
  UNKNOWN_REFERENCE_CITED: 'MEDIUM',
};

/** Consecutive-word run treated as reuse rather than coincidence. */
export const COPIED_PHRASE_WORD_COUNT = 8;
/** Beat durations are compared at this resolution — a frame of jitter is not originality. */
export const BEAT_COMPARISON_PRECISION = 1;

export const OriginalitySignalSchema = z
  .object({
    code: OriginalitySignalCodeSchema,
    severity: z.enum(['MEDIUM', 'HIGH']),
    agentRole: z.string().min(1),
    detail: z.string().min(1).max(600),
  })
  .strict();
export type OriginalitySignal = z.infer<typeof OriginalitySignalSchema>;

export const ORIGINALITY_REPORT_NOTICE =
  'Deterministic governance signal over structured agent output. Not a comprehensive copyright, plagiarism or similarity assessment, and not a substitute for human review.' as const;

export const OriginalityAssessmentSchema = z
  .object({
    reportVersion: z.literal(1),
    riskLevel: OriginalityRiskLevelSchema,
    /** True exactly when `riskLevel` is HIGH. Production planning must stop. */
    blocked: z.boolean(),
    /** True whenever the level is not LOW. */
    requiresHumanReview: z.boolean(),
    evaluatedRoles: z.array(z.string().min(1)),
    rolesWithContext: z.array(z.string().min(1)),
    signals: z.array(OriginalitySignalSchema),
    notice: z.literal(ORIGINALITY_REPORT_NOTICE),
  })
  .strict();
export type OriginalityAssessment = z.infer<typeof OriginalityAssessmentSchema>;

export interface OriginalityEvaluationEntry {
  readonly agentRole: CreativeMemoryAgentRole;
  /** The context this agent was given, when it was given one. */
  readonly context?: CreativeMemoryContext;
  readonly divergence?: CreativeDivergenceRecord;
  /** Every free-text field the agent produced. Order is irrelevant; content is not. */
  readonly outputText: readonly string[];
  /** Ordered planned beat lengths, when this role produced timing. */
  readonly beatDurationsSeconds?: readonly number[];
}

/** Lowercased word list with punctuation removed, so phrasing is compared and formatting is not. */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

function nGrams(text: string, size: number): Set<string> {
  const tokens = words(text);
  const grams = new Set<string>();
  for (let index = 0; index + size <= tokens.length; index += 1) {
    grams.add(tokens.slice(index, index + size).join(' '));
  }
  return grams;
}

/**
 * The reference-derived strings an agent could copy from.
 *
 * `intendedApplication`, `riskWarning`, `usageDirective` and `focusAreas` are
 * excluded: they are this system's own words, so echoing them back is
 * compliance, not reuse of a reference.
 */
function referenceProse(context: CreativeMemoryContext): string[] {
  return context.items.flatMap((item) => [
    item.craftPrinciple,
    ...Object.values(item.observations).filter(
      (value): value is string => typeof value === 'string',
    ),
  ]);
}

/**
 * Sentences that assert something, with prohibitions dropped.
 *
 * An agent restating its constraints — "this concept does not imitate any
 * agency" — is compliance, and flagging it as an imitation instruction would
 * punish exactly the behaviour the prompt asks for. Splitting on sentence
 * boundaries and discarding negated sentences keeps the check aimed at
 * affirmative direction, which is the thing that would actually reach a
 * downstream stage as an instruction.
 */
function affirmativeSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?;])\s+|\n+/)
    .filter(
      (sentence) => !/\b(?:do not|don't|does not|doesn't|never|avoid|without|no)\b/i.test(sentence),
    );
}

function roundSequence(values: readonly number[]): string {
  return values.map((value) => value.toFixed(BEAT_COMPARISON_PRECISION)).join(',');
}

/**
 * Evaluates every role in one pass and reduces to a single verdict.
 *
 * Signals are emitted in a stable order — entries in the order given, checks in
 * the order written — so the same plan always produces the same report, which
 * is what makes the report diffable across runs.
 */
export function evaluateOriginality(
  entries: readonly OriginalityEvaluationEntry[],
): OriginalityAssessment {
  const signals: OriginalitySignal[] = [];

  const add = (code: OriginalitySignalCode, agentRole: string, detail: string): void => {
    signals.push({
      code,
      severity: ORIGINALITY_SIGNAL_SEVERITY[code],
      agentRole,
      detail: detail.slice(0, 600),
    });
  };

  for (const entry of entries) {
    const role = entry.agentRole;
    const outputs = entry.outputText.filter((text) => typeof text === 'string' && text.length > 0);

    // Expressive material escaping into an output is independent of whether
    // Creative Memory ran — an agent that emits a path or URL is a problem
    // either way, so this check is not gated on a context.
    for (const text of outputs) {
      for (const pattern of AGENT_SAFE_FORBIDDEN_VALUE_PATTERNS) {
        if (pattern.test(text)) {
          add('FORBIDDEN_FIELD_IN_OUTPUT', role, `output matches ${pattern.source}`);
          break;
        }
      }
      const asserted = affirmativeSentences(text);
      const imitation = AGENCY_IMITATION_PATTERNS.find((pattern) =>
        asserted.some((sentence) => pattern.test(sentence)),
      );
      if (imitation) {
        add('NAMED_AGENCY_IMITATION', role, `output matches ${imitation.source}`);
      }
    }

    if (!entry.context) continue;

    if (!entry.divergence) {
      add(
        'MISSING_DIVERGENCE_RECORD',
        role,
        'Creative Memory context was injected but the agent returned no divergence record',
      );
    }

    // --- verbatim reuse ------------------------------------------------------
    const sourceGrams = new Set<string>();
    for (const prose of referenceProse(entry.context)) {
      for (const gram of nGrams(prose, COPIED_PHRASE_WORD_COUNT)) sourceGrams.add(gram);
    }
    if (sourceGrams.size > 0) {
      for (const text of outputs) {
        const matched = [...nGrams(text, COPIED_PHRASE_WORD_COUNT)].find((gram) =>
          sourceGrams.has(gram),
        );
        if (matched) {
          add(
            'COPIED_REFERENCE_PHRASE',
            role,
            `${COPIED_PHRASE_WORD_COUNT} consecutive words reproduced from a reference craft note: "${matched}"`,
          );
          break;
        }
      }
    }

    // --- replayed structure --------------------------------------------------
    if (entry.beatDurationsSeconds && entry.beatDurationsSeconds.length > 1) {
      const planned = roundSequence(entry.beatDurationsSeconds);
      for (const item of entry.context.items) {
        const sequence = item.measurements.sceneDurationsSeconds;
        if (
          sequence.length === entry.beatDurationsSeconds.length &&
          roundSequence(sequence) === planned
        ) {
          add(
            'IDENTICAL_BEAT_SEQUENCE',
            role,
            `planned beat lengths (${planned}) reproduce reference ${item.referenceId}'s scene sequence exactly`,
          );
          break;
        }
      }
    }

    // --- dependence and citation --------------------------------------------
    const contextReferences = new Set(entry.context.items.map((item) => item.referenceId));
    const cited = entry.divergence?.principlesUsed ?? [];
    for (const citation of cited) {
      if (!contextReferences.has(citation.referenceId)) {
        add(
          'UNKNOWN_REFERENCE_CITED',
          role,
          `divergence record cites reference ${citation.referenceId}, which was not in this agent's context`,
        );
        break;
      }
    }
    if (contextReferences.size > 1 && cited.length > 1) {
      const distinctCited = new Set(cited.map((citation) => citation.referenceId));
      if (distinctCited.size === 1) {
        add(
          'SINGLE_SOURCE_DEPENDENCE',
          role,
          `every cited principle comes from one reference while the context offered ${contextReferences.size}`,
        );
      }
    }

    if (entry.divergence?.originalityRiskLevel === 'HIGH') {
      add('AGENT_DECLARED_HIGH_RISK', role, entry.divergence.rationale);
    }
  }

  const riskLevel: OriginalityRiskLevel = signals.some((signal) => signal.severity === 'HIGH')
    ? 'HIGH'
    : signals.length > 0
      ? 'MEDIUM'
      : 'LOW';

  return {
    reportVersion: 1,
    riskLevel,
    blocked: riskLevel === 'HIGH',
    requiresHumanReview: riskLevel !== 'LOW',
    evaluatedRoles: entries.map((entry) => entry.agentRole),
    rolesWithContext: entries.filter((entry) => entry.context).map((entry) => entry.agentRole),
    signals,
    notice: ORIGINALITY_REPORT_NOTICE,
  };
}
