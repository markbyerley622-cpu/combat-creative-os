import { parseHumanPlan, type HumanCreativePlan, type PlanBeat } from '../preview/human-plan';
import type { CreativeFinishingBrief } from './finishing-contracts';
import { FinishingContractError, sha256OfJson } from './finishing-contracts';
import { axisOf, type FinishingOperation } from './finishing-directives';

/**
 * Applying a reviewer's directives to an approved plan.
 *
 * Pure, total and deterministic: same base plan plus same operations gives the
 * same candidate plan and therefore the same checksum, every time, with no
 * clock and no randomness. That is what makes a candidate re-derivable months
 * later from the artefacts alone, and what makes "these two candidates differ
 * only in the hook" a checkable statement rather than a claim.
 *
 * Two rules do most of the work here:
 *
 * - **Nothing is repaired.** An operation naming a beat that does not exist, a
 *   donor that cannot give up the time, or an asset the brief never approved
 *   is refused with the reviewer's own vocabulary. Quietly clamping a duration
 *   into range would produce a candidate nobody authored and the reviewer
 *   would judge it as if they had.
 * - **The result faces the same schema as a hand-written plan.** The candidate
 *   is re-parsed through `parseHumanPlan`, so an edit that broke the timeline,
 *   the CTA fit or the imitation prohibition is caught here rather than at
 *   render time — the schema is the contract, and there is no privileged path
 *   around it for plans this code produced.
 */

export class PlanEditError extends FinishingContractError {
  constructor(message: string, problems: readonly string[] = []) {
    super(message, problems);
    this.name = 'PlanEditError';
  }
}

/** Seconds are compared and stored at millisecond-ish precision, as the plan schema does. */
function round6(value: number): number {
  return Number(value.toFixed(6));
}

function requireBeat(plan: HumanCreativePlan, beatId: string, kind: string): PlanBeat {
  const beat = plan.beats.find((candidate) => candidate.id === beatId);
  if (!beat) {
    throw new PlanEditError(
      `${kind} names beat "${beatId}", which this plan does not have. Its beats are: ${plan.beats
        .map((entry) => entry.id)
        .join(', ')}`,
    );
  }
  return beat;
}

/** A mutable working copy, so each operation reads what the previous one wrote. */
type Draft = {
  plan: HumanCreativePlan;
};

function mapBeat(draft: Draft, beatId: string, change: (beat: PlanBeat) => PlanBeat): void {
  draft.plan = {
    ...draft.plan,
    beats: draft.plan.beats.map((beat) => (beat.id === beatId ? change(beat) : beat)),
  };
}

/**
 * Moves `delta` seconds onto `beatId` and takes them off `donorId`.
 *
 * The exact-duration rule is the plan's, not this module's invention: beats
 * minus transition overlaps must land on the requested duration. Any operation
 * that changes a duration therefore has to say where the time comes from, and
 * this is the one place that arithmetic happens.
 */
function transferTime(
  draft: Draft,
  beatId: string,
  donorId: string,
  delta: number,
  kind: string,
): void {
  if (beatId === donorId) {
    throw new PlanEditError(
      `${kind} asks beat "${beatId}" to donate the time to itself, which changes nothing and hides the fact that the timeline no longer adds up.`,
    );
  }
  const donor = requireBeat(draft.plan, donorId, kind);
  const donorDuration = round6(donor.durationSeconds - delta);
  const donorTransition = donor.transitionIn?.durationSeconds ?? 0;
  if (donorDuration <= 0) {
    throw new PlanEditError(
      `${kind} would leave donor beat "${donorId}" at ${donorDuration}s. Take the time from a longer beat, or ask for less of it.`,
    );
  }
  if (donorDuration <= donorTransition) {
    throw new PlanEditError(
      `${kind} would leave donor beat "${donorId}" at ${donorDuration}s, no longer than the ${donorTransition}s transition entering it. A beat cannot be shorter than the transition that opens it.`,
    );
  }
  mapBeat(draft, donorId, (beat) => ({ ...beat, durationSeconds: donorDuration }));
}

function applyOperation(
  draft: Draft,
  operation: FinishingOperation,
  brief: CreativeFinishingBrief,
): void {
  switch (operation.kind) {
    case 'SET_HOOK_LATENCY': {
      draft.plan = {
        ...draft.plan,
        hook: { ...draft.plan.hook, latencySeconds: operation.latencySeconds },
      };
      return;
    }
    case 'RETIME_BEAT': {
      const beat = requireBeat(draft.plan, operation.beatId, 'RETIME_BEAT');
      const target = round6(operation.durationSeconds);
      const transition = beat.transitionIn?.durationSeconds ?? 0;
      if (target <= transition) {
        throw new PlanEditError(
          `RETIME_BEAT would make beat "${beat.id}" ${target}s long, no longer than the ${transition}s transition entering it.`,
        );
      }
      transferTime(
        draft,
        beat.id,
        operation.compensateWithBeatId,
        round6(target - beat.durationSeconds),
        'RETIME_BEAT',
      );
      mapBeat(draft, beat.id, (entry) => ({ ...entry, durationSeconds: target }));
      return;
    }
    case 'SET_BEAT_MOTION': {
      requireBeat(draft.plan, operation.beatId, 'SET_BEAT_MOTION');
      mapBeat(draft, operation.beatId, (beat) => ({
        ...beat,
        motion: { treatment: operation.treatment, intensity: operation.intensity },
      }));
      return;
    }
    case 'SET_BEAT_TRANSITION': {
      const beat = requireBeat(draft.plan, operation.beatId, 'SET_BEAT_TRANSITION');
      if (!beat.transitionIn) {
        throw new PlanEditError(
          `SET_BEAT_TRANSITION names beat "${beat.id}", which is the first beat and has nothing to transition from.`,
        );
      }
      // A longer overlap shortens the timeline, so the donor gives up exactly
      // the difference — the same arithmetic, in the other direction.
      const delta = round6(operation.durationSeconds - beat.transitionIn.durationSeconds);
      transferTime(draft, beat.id, operation.compensateWithBeatId, -delta, 'SET_BEAT_TRANSITION');
      mapBeat(draft, beat.id, (entry) => ({
        ...entry,
        transitionIn: {
          kind: operation.transitionKind,
          durationSeconds: operation.durationSeconds,
        },
      }));
      return;
    }
    case 'SET_CAPTION_ENTRANCE': {
      const beat = requireBeat(draft.plan, operation.beatId, 'SET_CAPTION_ENTRANCE');
      if (!beat.caption) {
        throw new PlanEditError(
          `SET_CAPTION_ENTRANCE names beat "${beat.id}", which carries no caption. This operation moves how a line arrives; it cannot write one.`,
        );
      }
      const text = beat.caption.text;
      mapBeat(draft, beat.id, (entry) => ({
        ...entry,
        caption: { text, entrance: operation.entrance },
      }));
      return;
    }
    case 'SET_BEAT_IN_POINT': {
      requireBeat(draft.plan, operation.beatId, 'SET_BEAT_IN_POINT');
      mapBeat(draft, operation.beatId, (beat) => {
        // Rebuilt rather than spread-with-delete: clearing the pin has to
        // actually remove the field, or the selector keeps honouring it.
        const source = {
          ...(beat.source.assetId === undefined ? {} : { assetId: beat.source.assetId }),
          ...(beat.source.preferredRole === undefined
            ? {}
            : { preferredRole: beat.source.preferredRole }),
          requiredTags: beat.source.requiredTags,
          ...(operation.inSeconds === undefined ? {} : { inSeconds: operation.inSeconds }),
        };
        return { ...beat, source };
      });
      return;
    }
    case 'SET_BEAT_SOURCE': {
      requireBeat(draft.plan, operation.beatId, 'SET_BEAT_SOURCE');
      const approved = new Set([...brief.approvedFootageAssetIds, ...brief.approvedUiAssetIds]);
      if (!approved.has(operation.assetId)) {
        throw new PlanEditError(
          `SET_BEAT_SOURCE names asset "${operation.assetId}", which this brief did not approve. A finishing pass re-cuts approved material; introducing new footage is a new brief.`,
        );
      }
      mapBeat(draft, operation.beatId, (beat) => ({
        ...beat,
        // Binding by id makes the selector exact, so a pinned in-point from the
        // previous asset cannot silently carry over onto different footage.
        source: { assetId: operation.assetId, requiredTags: [] },
      }));
      return;
    }
    case 'ADD_DECORATION': {
      const beat = requireBeat(draft.plan, operation.beatId, 'ADD_DECORATION');
      if (beat.decorations.length >= 4) {
        throw new PlanEditError(
          `beat "${beat.id}" already carries ${beat.decorations.length} decorations, which is the plan's ceiling. Clear them first if this one replaces something.`,
        );
      }
      mapBeat(draft, beat.id, (entry) => ({
        ...entry,
        decorations: [
          ...entry.decorations,
          {
            key: operation.treatment,
            colour: operation.colour,
            opacity: operation.opacity,
            xPx: operation.xPx,
            yPx: operation.yPx,
            widthPx: operation.widthPx,
            heightPx: operation.heightPx,
            thicknessPx: operation.thicknessPx,
          },
        ],
      }));
      return;
    }
    case 'CLEAR_DECORATIONS': {
      requireBeat(draft.plan, operation.beatId, 'CLEAR_DECORATIONS');
      mapBeat(draft, operation.beatId, (beat) => ({ ...beat, decorations: [] }));
      return;
    }
    case 'SET_MIX': {
      const changes: Record<string, number> = {};
      for (const [key, value] of Object.entries(operation)) {
        if (key !== 'kind' && typeof value === 'number') changes[key] = value;
      }
      draft.plan = { ...draft.plan, audio: { ...draft.plan.audio, ...changes } };
      return;
    }
    case 'SET_BEAT_SOURCE_AUDIO': {
      requireBeat(draft.plan, operation.beatId, 'SET_BEAT_SOURCE_AUDIO');
      mapBeat(draft, operation.beatId, (beat) => ({
        ...beat,
        useSourceAudio: operation.useSourceAudio,
      }));
      return;
    }
    case 'SET_CTA_TIMING': {
      draft.plan = {
        ...draft.plan,
        cta: {
          ...draft.plan.cta,
          holdSeconds: operation.holdSeconds,
          ...(operation.entrance ? { entrance: operation.entrance } : {}),
        },
      };
      return;
    }
    default: {
      const unreachable: never = operation;
      throw new PlanEditError(
        `unknown finishing operation "${String((unreachable as { kind?: string }).kind)}"`,
      );
    }
  }
}

export interface AppliedChange {
  readonly axis: ReturnType<typeof axisOf>;
  readonly field: string;
  readonly from: string;
  readonly to: string;
}

export interface PlanEditResult {
  readonly plan: HumanCreativePlan;
  readonly planSha256: string;
  readonly changes: readonly AppliedChange[];
}

/** A short, human-readable statement of what an operation touched. */
function describe(operation: FinishingOperation): string {
  switch (operation.kind) {
    case 'SET_HOOK_LATENCY':
      return 'hook.latencySeconds';
    case 'SET_MIX':
      return 'audio';
    case 'SET_CTA_TIMING':
      return 'cta';
    default:
      return `beats.${operation.beatId}`;
  }
}

/** Reads the value a `describe` field points at, for the before/after record. */
function readField(plan: HumanCreativePlan, field: string): string {
  if (field === 'hook.latencySeconds') return String(plan.hook.latencySeconds);
  if (field === 'audio') return JSON.stringify(plan.audio);
  if (field === 'cta') return JSON.stringify(plan.cta);
  const beatId = field.slice('beats.'.length);
  const beat = plan.beats.find((entry) => entry.id === beatId);
  return beat ? JSON.stringify(beat) : '(absent)';
}

/** Before/after strings are bounded — a changelog is a summary, not a plan dump. */
function clip(text: string): string {
  return text.length <= 300 ? text : `${text.slice(0, 297)}...`;
}

export function applyFinishingOperations(
  basePlan: HumanCreativePlan,
  operations: readonly FinishingOperation[],
  brief: CreativeFinishingBrief,
): PlanEditResult {
  const draft: Draft = { plan: basePlan };
  const changes: AppliedChange[] = [];

  for (const operation of operations) {
    const field = describe(operation);
    const before = readField(draft.plan, field);
    applyOperation(draft, operation, brief);
    const after = readField(draft.plan, field);
    changes.push({
      axis: axisOf(operation),
      field: `${operation.kind} → ${field}`,
      from: clip(before),
      to: clip(after),
    });
  }

  // The edited plan faces exactly the schema a hand-written one faces. An edit
  // that broke the timeline is caught here, not three stages later.
  let plan: HumanCreativePlan;
  try {
    plan = parseHumanPlan(JSON.parse(JSON.stringify(draft.plan)));
  } catch (error) {
    throw new PlanEditError(
      `applying these operations produced a plan the schema refuses:\n${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return { plan, planSha256: sha256OfJson(plan), changes };
}
