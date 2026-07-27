/**
 * Which tier of real infrastructure a run actually stood on.
 *
 * `execution-mode.ts` (the ComfyUI-gateway milestone's module) answers a
 * narrower question — was the *creative* real and was the *footage* real. This
 * module answers the operational one: did this run reach live PostgreSQL, live
 * Qdrant and a real FFmpeg toolchain, or did it stand on deterministic
 * substitutes? The two are orthogonal and both are reported; neither replaces
 * the other.
 *
 * The rule that makes the label trustworthy is that **the mode is derived from
 * evidence, never from what the operator typed**. `--execution-mode` states a
 * *required floor*: it can cause a run to refuse, and it can never promote a
 * run's label. A run whose reasoning came from a committed fixture cannot be
 * labelled PRODUCTION no matter what the command line said, because
 * `resolveAttainedExecutionMode` never sees the flag.
 */

export const AAMP_EXECUTION_MODES = [
  /**
   * Deterministic providers and in-memory persistence are permitted. Every
   * output is stamped DEMONSTRATION ONLY and `isRealCampaignRun` is false.
   */
  'FIXTURE',
  /**
   * The creative decisions were made by a person and supplied as a validated
   * plan file; no reasoning model and no generation provider was called at all.
   *
   * This is a genuinely different claim from either neighbour, which is why it
   * is its own mode rather than a flag on one of them. A FIXTURE run replays
   * canned creative that ignores the campaign prompt entirely. A
   * LOCAL_PRODUCTION run had a model make the decisions. This one had a *human*
   * make them, for this campaign, and then executed them deterministically —
   * so it is worth more than a fixture demonstration and is not a production
   * campaign result. `isRealCampaignRun` stays false: the pipeline did not
   * originate the creative, and saying otherwise would be the exact
   * overstatement this module exists to prevent.
   */
  'HUMAN_ASSISTED_PREVIEW',
  /**
   * Live local PostgreSQL, live local Qdrant and a real FFmpeg toolchain.
   * Fixture *reasoning* is still permitted here — but only when the operator
   * asked for it by name — and the output says exactly which halves were real.
   */
  'LOCAL_PRODUCTION',
  /**
   * Everything real: Prisma-backed persistence, a real reasoning model, real
   * generation where the request asks for it, real rendering and actual-media
   * QA. No fixture provider and no in-memory repository can appear.
   */
  'PRODUCTION',
] as const;
export type AampExecutionMode = (typeof AAMP_EXECUTION_MODES)[number];

/** Rank, so "at least LOCAL_PRODUCTION" is expressible. */
const MODE_RANK: Readonly<Record<AampExecutionMode, number>> = {
  FIXTURE: 0,
  HUMAN_ASSISTED_PREVIEW: 1,
  LOCAL_PRODUCTION: 2,
  PRODUCTION: 3,
};

export function executionModeRank(mode: AampExecutionMode): number {
  return MODE_RANK[mode];
}

/**
 * Whether an attained mode satisfies a requested floor.
 *
 * Rank alone is not enough for `HUMAN_ASSISTED_PREVIEW`. It sits above FIXTURE
 * because a human made the decisions for this campaign, but it is not a weaker
 * LOCAL_PRODUCTION — it is a different kind of run, and an operator who asked
 * for a human-assisted preview and silently got a model-planned one has been
 * given something they did not ask for. So that mode is matched exactly, while
 * the others keep the ordinary "at least this tier" meaning.
 */
export function satisfiesExecutionFloor(
  requested: AampExecutionMode,
  attained: AampExecutionMode,
): boolean {
  if (requested === 'HUMAN_ASSISTED_PREVIEW' || attained === 'HUMAN_ASSISTED_PREVIEW') {
    return requested === attained;
  }
  return executionModeRank(attained) >= executionModeRank(requested);
}

/** Accepts the CLI's kebab-case spelling; returns `undefined` for anything else. */
export function parseExecutionModeFlag(value: string | undefined): AampExecutionMode | undefined {
  switch ((value ?? '').trim().toLowerCase()) {
    case 'fixture':
      return 'FIXTURE';
    case 'human-assisted-preview':
      return 'HUMAN_ASSISTED_PREVIEW';
    case 'local-production':
      return 'LOCAL_PRODUCTION';
    case 'production':
      return 'PRODUCTION';
    default:
      return undefined;
  }
}

export function executionModeFlagFor(mode: AampExecutionMode): string {
  return mode.toLowerCase().replace(/_/g, '-');
}

/**
 * What each dependency actually was.
 *
 * `NOT_REQUIRED` is a distinct value from "simulated" on purpose. A source-only
 * campaign genuinely needs no video-generation provider, and a `--plan-only`
 * run genuinely renders nothing; recording those as simulated would understate
 * a run that in fact used everything it needed. Recording them as real would
 * overstate it. So they get their own value and are excluded from both lists.
 */
export const PERSISTENCE_KINDS = [
  'PRISMA_POSTGRESQL',
  'IN_MEMORY',
  'UNAVAILABLE',
  'NOT_REQUIRED',
] as const;
export type PersistenceKind = (typeof PERSISTENCE_KINDS)[number];

export const VECTOR_SEARCH_KINDS = [
  'QDRANT_LIVE',
  'IN_PROCESS',
  'UNAVAILABLE',
  'NOT_REQUIRED',
] as const;
export type VectorSearchKind = (typeof VECTOR_SEARCH_KINDS)[number];

/**
 * `HUMAN_SUPPLIED_PLAN` is a third thing, not a variety of the other two.
 *
 * No reasoning provider was constructed, so none could have been called: the
 * creative arrived as a validated plan file written by a person. Folding it
 * into `FIXTURE_REPLAY` would claim the campaign prompt was ignored, which is
 * false; folding it into `REAL_MODEL` would claim a model produced it, which
 * is worse.
 */
export const REASONING_KINDS = ['REAL_MODEL', 'FIXTURE_REPLAY', 'HUMAN_SUPPLIED_PLAN'] as const;
export type ReasoningKind = (typeof REASONING_KINDS)[number];

export const GENERATION_KINDS = ['COMFYUI_LIVE', 'FIXTURE_TEST_PATTERN', 'NOT_REQUIRED'] as const;
export type GenerationKind = (typeof GENERATION_KINDS)[number];

/**
 * `UNAVAILABLE` is not `SIMULATED`. It means the run needed a renderer, was not
 * required to reach any particular tier, and did not have one — so it will
 * proceed as far as it can and fail at the render if it gets there. Recording
 * that as "simulated" would imply something stood in; recording it as
 * `NOT_REQUIRED` would claim the run never needed it.
 */
export const RENDERING_KINDS = ['FFMPEG_REAL', 'SIMULATED', 'UNAVAILABLE', 'NOT_REQUIRED'] as const;
export type RenderingKind = (typeof RENDERING_KINDS)[number];

export const QA_KINDS = ['ACTUAL_MEDIA', 'SIMULATED', 'UNAVAILABLE', 'NOT_REQUIRED'] as const;
export type QaKind = (typeof QA_KINDS)[number];

export interface DependencyEvidence {
  readonly persistence: PersistenceKind;
  readonly vectorSearch: VectorSearchKind;
  readonly reasoning: ReasoningKind;
  readonly videoGeneration: GenerationKind;
  readonly rendering: RenderingKind;
  readonly qa: QaKind;
}

/**
 * What a mode demands of each axis, as data rather than as a chain of
 * conditionals — so adding an axis forces a decision about every mode instead
 * of silently defaulting to "permitted".
 */
const REQUIREMENTS: Readonly<
  Record<
    AampExecutionMode,
    {
      readonly [K in keyof DependencyEvidence]: readonly DependencyEvidence[K][];
    }
  >
> = {
  FIXTURE: {
    persistence: [...PERSISTENCE_KINDS],
    vectorSearch: [...VECTOR_SEARCH_KINDS],
    reasoning: [...REASONING_KINDS],
    videoGeneration: [...GENERATION_KINDS],
    rendering: [...RENDERING_KINDS],
    qa: [...QA_KINDS],
  },
  HUMAN_ASSISTED_PREVIEW: {
    // The infrastructure axes are deliberately unconstrained: what defines
    // this mode is *where the creative came from*, and a preview is just as
    // legitimate against an in-memory store as against live PostgreSQL. The
    // label still lists every substituted component, so nothing is hidden.
    persistence: [...PERSISTENCE_KINDS],
    vectorSearch: [...VECTOR_SEARCH_KINDS],
    // The one axis that is pinned. A run that called a model is not a
    // human-assisted preview, whatever else was true of it.
    reasoning: ['HUMAN_SUPPLIED_PLAN'],
    // Zero generation calls is a promise this mode makes to the operator, so
    // it is enforced structurally rather than documented.
    videoGeneration: ['NOT_REQUIRED'],
    rendering: [...RENDERING_KINDS],
    qa: [...QA_KINDS],
  },
  LOCAL_PRODUCTION: {
    persistence: ['PRISMA_POSTGRESQL', 'NOT_REQUIRED'],
    vectorSearch: ['QDRANT_LIVE', 'NOT_REQUIRED'],
    // Fixture reasoning is deliberately permitted here. It is the one
    // substitution a local operator legitimately wants — it needs no paid key
    // — and the label says so loudly rather than pretending otherwise. A
    // human-supplied plan is *not* permitted: it has its own mode, and letting
    // it resolve here would erase the distinction.
    reasoning: ['REAL_MODEL', 'FIXTURE_REPLAY'],
    videoGeneration: [...GENERATION_KINDS],
    rendering: ['FFMPEG_REAL', 'NOT_REQUIRED'],
    qa: ['ACTUAL_MEDIA', 'NOT_REQUIRED'],
  },
  PRODUCTION: {
    persistence: ['PRISMA_POSTGRESQL'],
    vectorSearch: ['QDRANT_LIVE', 'NOT_REQUIRED'],
    reasoning: ['REAL_MODEL'],
    videoGeneration: ['COMFYUI_LIVE', 'NOT_REQUIRED'],
    rendering: ['FFMPEG_REAL', 'NOT_REQUIRED'],
    qa: ['ACTUAL_MEDIA', 'NOT_REQUIRED'],
  },
};

const AXIS_LABELS: Readonly<Record<keyof DependencyEvidence, string>> = {
  persistence: 'persistence',
  vectorSearch: 'Creative Memory vector search',
  reasoning: 'reasoning provider',
  videoGeneration: 'video generation',
  rendering: 'rendering',
  qa: 'actual-media QA',
};

/** Every reason `evidence` falls short of `mode`, in a stable axis order. */
export function shortfallsFor(
  mode: AampExecutionMode,
  evidence: DependencyEvidence,
): readonly string[] {
  const required = REQUIREMENTS[mode];
  const problems: string[] = [];
  for (const axis of Object.keys(AXIS_LABELS) as (keyof DependencyEvidence)[]) {
    const permitted = required[axis] as readonly string[];
    const actual = evidence[axis] as string;
    if (!permitted.includes(actual)) {
      problems.push(
        `${AXIS_LABELS[axis]} was ${actual}; ${mode} permits only ${permitted.join(' or ')}`,
      );
    }
  }
  return problems;
}

/**
 * The highest mode the evidence actually supports.
 *
 * Deliberately takes no requested mode and no configuration — it sees only what
 * was built. That is the whole guarantee: a LOCAL_PRODUCTION run cannot be
 * mislabelled PRODUCTION, because nothing that could mislabel it is in scope.
 */
export function resolveAttainedExecutionMode(evidence: DependencyEvidence): AampExecutionMode {
  // Checked before the infrastructure tiers because it is decided by a
  // different axis: only a human-supplied plan can reach it, and nothing else
  // can. The order therefore cannot cause a model-planned run to be labelled a
  // preview, or the reverse.
  if (shortfallsFor('HUMAN_ASSISTED_PREVIEW', evidence).length === 0) {
    return 'HUMAN_ASSISTED_PREVIEW';
  }
  if (shortfallsFor('PRODUCTION', evidence).length === 0) return 'PRODUCTION';
  if (shortfallsFor('LOCAL_PRODUCTION', evidence).length === 0) return 'LOCAL_PRODUCTION';
  return 'FIXTURE';
}

const REAL_VALUES: ReadonlySet<string> = new Set([
  'PRISMA_POSTGRESQL',
  'QDRANT_LIVE',
  'REAL_MODEL',
  'COMFYUI_LIVE',
  'FFMPEG_REAL',
  'ACTUAL_MEDIA',
]);
const SIMULATED_VALUES: ReadonlySet<string> = new Set([
  'IN_MEMORY',
  'IN_PROCESS',
  'FIXTURE_REPLAY',
  'FIXTURE_TEST_PATTERN',
  'SIMULATED',
  'UNAVAILABLE',
]);

export interface ExecutionModeLabel {
  readonly executionMode: AampExecutionMode;
  /** True only for PRODUCTION. Everything else is a demonstration of something. */
  readonly isRealCampaignRun: boolean;
  /** True only for FIXTURE — nothing about this output is evidence of anything real. */
  readonly demonstrationOnly: boolean;
  /** True when at least one axis was substituted but the run still stood on real infrastructure. */
  readonly partiallySimulated: boolean;
  readonly realComponents: readonly string[];
  readonly simulatedComponents: readonly string[];
  readonly caveat: string;
}

/**
 * The sentence printed before the run, printed after it, and written into every
 * artefact.
 *
 * Specific about *which* half was substituted, because "this is a demo" is easy
 * to skim past and "the creative is replayed from committed fixtures and
 * ignores your prompt" is not.
 */
export function describeExecutionEvidence(evidence: DependencyEvidence): ExecutionModeLabel {
  const executionMode = resolveAttainedExecutionMode(evidence);
  const realComponents: string[] = [];
  const simulatedComponents: string[] = [];

  for (const axis of Object.keys(AXIS_LABELS) as (keyof DependencyEvidence)[]) {
    const value = evidence[axis] as string;
    const entry = `${AXIS_LABELS[axis]}: ${value}`;
    if (REAL_VALUES.has(value)) realComponents.push(entry);
    else if (SIMULATED_VALUES.has(value)) simulatedComponents.push(entry);
  }

  const caveat =
    executionMode === 'PRODUCTION'
      ? 'PRODUCTION: every dependency this run needed was real. Human approval is still required before publication.'
      : executionMode === 'LOCAL_PRODUCTION'
        ? `LOCAL_PRODUCTION — PARTIALLY SIMULATED. Real: ${realComponents.join('; ') || 'none'}. Simulated: ${
            simulatedComponents.join('; ') || 'none'
          }. This is not a campaign result.`
        : `FIXTURE — DEMONSTRATION ONLY. Simulated: ${
            simulatedComponents.join('; ') || 'none'
          }. Nothing here is evidence about creative quality or about a real advertisement.`;

  return {
    executionMode,
    isRealCampaignRun: executionMode === 'PRODUCTION',
    demonstrationOnly: executionMode === 'FIXTURE',
    partiallySimulated: executionMode !== 'PRODUCTION' && simulatedComponents.length > 0,
    realComponents,
    simulatedComponents,
    caveat,
  };
}
