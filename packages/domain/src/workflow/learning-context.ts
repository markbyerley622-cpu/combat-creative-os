import type { DeliveryPlatform } from '../schemas/shared-enums';
import type {
  LearningConfidence,
  LearningContextItem,
  LearningRecord,
  LearningScope,
} from '../schemas/learning-record';

/**
 * M13 — selects the bounded, attributable learning context an agent may see.
 *
 * This function is the whole answer to "no unrestricted historical prompt
 * dumping". Everything it returns is:
 *
 * - **filtered** to APPROVED, non-superseded records in the caller's workspace
 *   whose `scope` matches the agent and whose `applicability` overlaps the
 *   campaign (platform / duration);
 * - **capped** at `MAX_LEARNING_CONTEXT_ITEMS`, highest-confidence first, so the
 *   payload cannot grow with workspace history;
 * - **attributable** — each item keeps its record id, key, version, confidence
 *   and evidence weight, so any downstream claim is traceable to a source;
 * - **advisory** — the shape carries no instruction, no approval, no asset
 *   reference. It is offered alongside the approved brief and can never replace
 *   it. Nothing in this module or its callers lets a learning change a campaign
 *   stage, an approval, an asset or a human decision.
 *
 * Pure and I/O-free: the Activity loads candidate records, this decides which
 * ones (if any) are allowed through.
 */

/** Hard cap on how many learnings may ever reach one agent invocation. */
export const MAX_LEARNING_CONTEXT_ITEMS = 5;

/**
 * Minimum band that may be injected at all. LOW-confidence insights are kept
 * and reviewable in the dashboard, but are never put in front of an agent —
 * a thin-evidence claim should not shape a strategy.
 */
export const MIN_INJECTABLE_CONFIDENCE: LearningConfidence = 'MEDIUM';

const CONFIDENCE_RANK: Readonly<Record<LearningConfidence, number>> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
};

export interface LearningContextRequest {
  readonly scope: LearningScope;
  /** The campaign the context is being assembled for — its own learnings are still eligible. */
  readonly targetPlatforms: readonly DeliveryPlatform[];
  readonly targetDurationsSeconds: readonly number[];
  readonly maxItems?: number;
  readonly minConfidence?: LearningConfidence;
}

/** An empty applicability array means "unrestricted on that dimension". */
function overlaps<T>(restriction: readonly T[], target: readonly T[]): boolean {
  if (restriction.length === 0) return true;
  if (target.length === 0) return false;
  return restriction.some((r) => target.includes(r));
}

export function toLearningContextItem(record: LearningRecord): LearningContextItem {
  return {
    learningRecordId: record.id,
    learningKey: record.learningKey,
    version: record.version,
    insight: record.insight,
    confidence: record.confidence,
    evidenceCount: record.evidence.length,
    totalImpressions: record.totalImpressions,
    applicability: record.applicability,
  };
}

/**
 * Filters, ranks and caps candidate records into the bounded context payload.
 * `candidates` is expected to already be workspace-scoped by the repository —
 * this adds every other restriction.
 */
export function selectLearningContext(
  candidates: readonly LearningRecord[],
  request: LearningContextRequest,
): LearningContextItem[] {
  const maxItems = request.maxItems ?? MAX_LEARNING_CONTEXT_ITEMS;
  const minRank = CONFIDENCE_RANK[request.minConfidence ?? MIN_INJECTABLE_CONFIDENCE];

  return candidates
    .filter(
      (r) =>
        r.status === 'APPROVED' &&
        r.supersededAt === undefined &&
        r.scope === request.scope &&
        CONFIDENCE_RANK[r.confidence] >= minRank &&
        overlaps(r.applicability.platforms, request.targetPlatforms) &&
        overlaps(r.applicability.durationsSeconds, request.targetDurationsSeconds),
    )
    .sort(
      (a, b) =>
        CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence] ||
        b.totalImpressions - a.totalImpressions ||
        b.evidence.length - a.evidence.length ||
        a.learningKey.localeCompare(b.learningKey),
    )
    .slice(0, maxItems)
    .map(toLearningContextItem);
}

/**
 * Renders bounded context into the plain attributed strings the existing
 * Strategist/Creative Director contracts accept (`priorLearnings: string[]`).
 * The record id is carried in the text so provenance survives into the prompt
 * — a reviewer reading a Strategy can trace any influenced claim back to a
 * specific `LearningRecord`, and the confidence band travels with it so the
 * agent is never handed an unqualified assertion.
 */
export function formatLearningContext(items: readonly LearningContextItem[]): string[] {
  return items.map(
    (item) =>
      `[${item.confidence} confidence · ${item.evidenceCount} observation(s) · ${item.totalImpressions} impressions · learning:${item.learningRecordId} v${item.version}] ${item.insight}`,
  );
}
