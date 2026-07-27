import {
  LAUNCH_EMOTIONAL_ARCS,
  LAUNCH_END_FRAME_STRATEGIES,
  LAUNCH_INTERFACE_PRESENTATIONS,
  LAUNCH_NARRATIVE_STRUCTURES,
  LAUNCH_PACING_TREATMENTS,
  LAUNCH_PRODUCT_PRESENCE_STRATEGIES,
  LAUNCH_SOUND_DIRECTIONS,
} from '@combat/domain';
import type { CreativeMemoryContext } from '@combat/domain';
import type {
  ReasoningInvokeInput,
  ReasoningModelMeta,
  ReasoningProvider,
} from '@combat/providers';

/**
 * A deterministic reasoning provider for launch **demonstrations**.
 *
 * It exists to exercise the orchestration — the competition, the distinctness
 * comparison, the assessment, the gate, the revision chain and the handoff —
 * on a machine with no API key, and it is labelled a demonstration everywhere
 * its output travels.
 *
 * Two properties make it honest rather than a cheat:
 *
 * - **Every value is derived from the input it was given.** The brand name, the
 *   campaign prompt, the positioning, the audience perception and the bracketed
 *   factual-constraint ids all come out of the agent envelope. There is no
 *   campaign-specific concept, hook, caption or headline written into this file
 *   — a source-hygiene test asserts that, and it is why this can sit beside
 *   application code without becoming the creative.
 * - **It occupies a different structural position per candidate slot**, by
 *   indexing every axis vocabulary at the slot number. The vocabularies are
 *   different lengths, so two slots land on a different value on every axis —
 *   which is what the directive *asks* a real model to do. Doing it
 *   arithmetically here makes the mechanism testable without claiming anything
 *   about judgement.
 *
 * It lives in `apps/aamp-cli`, outside `packages/providers`, so no worker
 * configuration value can select it, and `PRODUCTION` refuses it structurally.
 */

export const LAUNCH_FIXTURE_MODEL = 'deterministic-launch-fixture';

interface Envelope {
  readonly input: Record<string, unknown>;
}

function parseEnvelope(input: ReasoningInvokeInput): Envelope {
  const first = input.messages[0];
  const raw = typeof first?.content === 'string' ? first.content : '{}';
  const parsed = JSON.parse(raw) as { input?: Record<string, unknown> };
  return { input: parsed.input ?? {} };
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function list(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/** `PRODUCT [id] — Label: detail` → `{ id, label, detail }`, ignoring anything else. */
function parseConstraint(line: string): { id: string; label: string; detail: string } | undefined {
  const match = /^(?:PRODUCT|EVENT)\s*\[([^\]]+)\]\s*—\s*([^:]+):\s*(.*)$/u.exec(line);
  if (!match) return undefined;
  return {
    id: (match[1] ?? '').trim(),
    label: (match[2] ?? '').trim(),
    detail: (match[3] ?? '').trim(),
  };
}

/** Lowercased words of a vocabulary value, so `TENSION_TO_RELEASE` reads as prose. */
function phrase(kind: string): string {
  return kind.toLowerCase().replace(/_/g, ' ');
}

function pick<T>(values: readonly T[], index: number): T {
  return values[index % values.length] as T;
}

function contextOf(input: Record<string, unknown>): CreativeMemoryContext | undefined {
  const value = input.creativeMemory;
  return value && typeof value === 'object' ? (value as CreativeMemoryContext) : undefined;
}

/**
 * The divergence record an injected context obliges an agent to return.
 *
 * Derived from measurements and expressed in the fixture's own words, because a
 * record that echoed a reviewer's prose would trip the very originality
 * evaluator it is supposed to satisfy. Every retrieved reference is cited, so
 * the run does not read as leaning on one source.
 */
function divergenceFor(
  agentRole: 'CAMPAIGN_STRATEGIST' | 'CREATIVE_DIRECTOR',
  context: CreativeMemoryContext,
  transformation: string,
): Record<string, unknown> {
  return {
    agentRole,
    principlesUsed: context.items.map((item) => ({
      referenceId: item.referenceId,
      principleSummary: `Rank ${item.finalRank}: ${item.measurements.pacing} pacing at ${item.measurements.cutsPerSecond.toFixed(2)} cuts per second.`,
    })),
    campaignSpecificTransformation: transformation,
    elementsDeliberatelyChanged: [
      'Every derived value was recomputed against this campaign’s own duration and facts.',
    ],
    prohibitedElementsAvoided: [
      'No reference wording was reused; only measurements crossed into this output.',
      'No agency, studio or existing campaign was named.',
    ],
    originalityRiskLevel: 'LOW',
    rationale:
      'Only numeric craft measurements informed this output, and each was applied to this brief’s own structure.',
  };
}

function strategistResult(input: Record<string, unknown>): Record<string, unknown> {
  const launch = (input.productLaunch ?? {}) as Record<string, unknown>;
  const positioning = text(launch.positioning, text(input.objective, 'the stated objective'));
  const perception = text(launch.desiredAudiencePerception, 'the stated audience perception');
  const constraints = list(input.factualConstraints)
    .map(parseConstraint)
    .filter((entry): entry is { id: string; label: string; detail: string } => entry !== undefined);
  const identity = (launch.brandIdentity ?? {}) as Record<string, unknown>;
  const context = contextOf(input);

  return {
    ...(context
      ? {
          creativeMemoryDivergence: divergenceFor(
            'CAMPAIGN_STRATEGIST',
            context,
            'Positioning and messages were written from this brief’s own facts; the retrieved measurements informed only how much has to land early.',
          ),
        }
      : {}),
    audienceProfile: {
      name: text(input.objective, 'the intended audience'),
      demographics: {},
      psychographics: {},
      painPoints: constraints.slice(0, 3).map((entry) => `${entry.label}: ${entry.detail}`),
      platformBehavior: {},
    },
    strategy: {
      positioning,
      targetAudienceSummary: perception,
      keyMessages:
        list(input.keyMessages).length > 0
          ? list(input.keyMessages)
          : constraints.slice(0, 2).map((entry) => `${entry.label}: ${entry.detail}`),
      toneGuidelines: [
        text(identity.voice, 'the declared brand voice'),
        ...list(identity.personalityAttributes).slice(0, 3),
      ].filter((entry) => entry.length > 0),
    },
  };
}

function directorResult(input: Record<string, unknown>): Record<string, unknown> {
  const brand = text(input.brandName, 'the product');
  const launch = (input.productLaunch ?? {}) as Record<string, unknown>;
  const directive = (input.launchDirective ?? {}) as Record<string, unknown>;
  const strategy = (input.strategy ?? {}) as Record<string, unknown>;
  const positioning = text(strategy.positioning, text(launch.positioning, 'the positioning'));
  const perception = text(launch.desiredAudiencePerception, 'the intended perception');
  const revision = text(input.revisionFeedback, '');

  const constraints = list(input.factualConstraints)
    .map(parseConstraint)
    .filter((entry): entry is { id: string; label: string; detail: string } => entry !== undefined);

  // The slot index drives every axis. A revision shifts it by one so the next
  // version is a different structural position rather than the same one again.
  const slot = Math.max(1, Number(directive.candidateIndex ?? 1)) - 1;
  const offset = revision ? slot + 1 : slot;

  const narrative = pick(LAUNCH_NARRATIVE_STRUCTURES, offset);
  const arc = pick(LAUNCH_EMOTIONAL_ARCS, offset);
  const presence = pick(LAUNCH_PRODUCT_PRESENCE_STRATEGIES, offset);
  const surface = pick(LAUNCH_INTERFACE_PRESENTATIONS, offset);
  const pacing = pick(LAUNCH_PACING_TREATMENTS, offset);
  const sound = pick(LAUNCH_SOUND_DIRECTIONS, offset);
  const ending = pick(LAUNCH_END_FRAME_STRATEGIES, offset);

  const lead = constraints[offset % Math.max(1, constraints.length)];
  const leadLabel = lead ? lead.label : positioning;
  const leadDetail = lead ? lead.detail : perception;

  // Vocabulary that differs per slot, so the deterministic distinctness
  // comparison has something real to compare rather than a fixed sentence.
  const centralIdea = `${phrase(narrative)} built on ${leadLabel.toLowerCase()}, where ${phrase(
    presence,
  )} meets ${phrase(surface)} at ${phrase(pacing)} rhythm${revision ? ', reconsidered after review' : ''}.`;

  const capture = list((launch as { requiredCaptureIds?: unknown }).requiredCaptureIds);
  const context = contextOf(input);

  return {
    ...(context
      ? {
          creativeMemoryDivergence: divergenceFor(
            'CREATIVE_DIRECTOR',
            context,
            `Structural position ${offset + 1} was chosen for this slot; the retrieved measurements informed rhythm only, and every field was written for this brief.`,
          ),
        }
      : {}),
    logline: `${brand}: ${leadDetail}`,
    visualDirection: `Vertical 9:16 throughout. ${phrase(surface)} for the interface, ${phrase(
      pacing,
    )} cutting, resolving on ${phrase(ending)}.`,
    narrativeArc: `${phrase(narrative)} carrying ${phrase(arc)}.`,
    referenceNotes: [],
    launchConcept: {
      conceptSchemaVersion: 1,
      title: `${brand} direction ${slot + 1}${revision ? ' revised' : ''}`,
      centralIdea,
      intendedAudienceResponse: perception,
      narrativeStructure: {
        kind: narrative,
        direction: `Shape the cut as ${phrase(narrative)} against ${positioning}.`,
      },
      emotionalArc: { kind: arc, direction: `Carry the viewer through ${phrase(arc)}.` },
      productPresence: {
        kind: presence,
        direction: `Hold the product as ${phrase(presence)} throughout.`,
      },
      interfacePresentation: {
        kind: surface,
        direction: `Present real product screens as ${phrase(surface)}.`,
      },
      pacing: { kind: pacing, direction: `Cut at ${phrase(pacing)} across the master.` },
      soundDesign: { kind: sound, direction: `Treat sound as ${phrase(sound)}.` },
      endFrame: { kind: ending, direction: `Resolve on ${phrase(ending)}.` },
      combatCultureRelationship: `The culture supplies the stakes and the product supplies the record of them, joined as ${phrase(
        presence,
      )}.`,
      cinematographyDirection: `High-contrast vertical framing, ${phrase(pacing)}, no text outside the declared safe areas.`,
      motionDesignDirection: `Motion follows ${phrase(pacing)}; transitions stay within the catalogue the renderer supports.`,
      typographyDirection: `One readable line per beat in the declared caption family, sized for arm's-length reading.`,
      assetRoleRequirements: [
        { assetRole: 'APP_SCREENSHOT', necessity: 'REQUIRED', purpose: `Show ${leadLabel}.` },
        { assetRole: 'SOURCE_CLIP', necessity: 'REQUIRED', purpose: 'Carry the opening energy.' },
        { assetRole: 'BRAND_CARD', necessity: 'PREFERRED', purpose: 'Close the cut.' },
      ],
      factualProductClaims:
        constraints.length > 0
          ? constraints.slice(0, 3).map((entry) => ({ factId: entry.id, claim: entry.detail }))
          : [{ factId: 'unknown', claim: positioning }],
      prohibitedImplications: list(launch.prohibitedClaims).slice(0, 4),
      originalityRationale: `Structure, presence, surface, rhythm, sound and ending were chosen for slot ${
        slot + 1
      } so this candidate occupies a different structural position from the others in the set.`,
      referencePatternProvenance: (context?.items ?? []).map((item) => ({
        referenceId: item.referenceId,
        patternSummary: `${item.measurements.pacing} pacing measured at ${item.measurements.cutsPerSecond.toFixed(2)} cuts per second.`,
        appliedAs: `Recomputed as ${phrase(pacing)} for this ${
          (input.durationsSeconds as number[] | undefined)?.[0] ?? 15
        }s master.`,
      })),
      feasibility: {
        confidence: 'MEDIUM',
        requiredCaptureIds: capture,
        risks: [],
        durationFitNote: `The ${phrase(narrative)} shape survives a shorter cut by dropping interior beats before the ending.`,
      },
    },
  };
}

function resultFor(input: Record<string, unknown>): Record<string, unknown> {
  if ('launchDirective' in input) return directorResult(input);
  if ('shot' in input) return shotResult(input);
  if ('logline' in input) return scriptResult(input);
  if ('strategy' in input) return directorResult(input);
  return strategistResult(input);
}

/**
 * Beats for the render stage, distributed so they sum exactly to the requested
 * frame count — a script whose beats do not add up is refused downstream, and
 * absorbing the difference silently would hide it.
 */
function scriptResult(input: Record<string, unknown>): Record<string, unknown> {
  const frameRate = Number(input.frameRate ?? 30);
  const durations = (input.targetDurationsSeconds as number[] | undefined) ?? [15];
  const totalFrames = Math.round((durations[0] ?? 15) * frameRate);
  const beats = ['HOOK', 'PROMISE', 'FEATURE', 'CTA'] as const;
  const each = Math.floor(totalFrames / beats.length);

  return {
    totalDurationFrames: totalFrames,
    shots: beats.map((beat, index) => ({
      index,
      description: `${text(input.logline, 'the concept')} — ${beat.toLowerCase()} beat`,
      durationFrames: index === beats.length - 1 ? totalFrames - each * (beats.length - 1) : each,
      beat,
      dependsOnShotIndices: [],
    })),
  };
}

function shotResult(input: Record<string, unknown>): Record<string, unknown> {
  const shot = (input.shot ?? {}) as { index?: number; description?: string };
  return {
    providerId: text(input.providerId, 'source-library'),
    promptText: `Vertical 9:16 shot ${shot.index ?? 0}: ${shot.description ?? 'campaign beat'}`,
    params: {},
    visualObjective: shot.description ?? 'Carry this beat clearly.',
    action: 'The beat plays out in frame.',
    subject: 'Product and culture',
    environment: 'Arena or product interface',
    lensFraming: 'Vertical medium',
    lighting: 'High contrast',
    colorTreatment: 'Cool neutral',
    cameraMovement: 'static',
    motionIntensity: 'LOW',
    transitionIn: 'CUT',
    transitionOut: 'CUT',
    textSafeAreas: [],
    continuityRequirements: [],
    qualityRubric: [],
  };
}

export class LaunchFixtureReasoningProvider implements ReasoningProvider {
  readonly name = 'launch-fixture-reasoning';
  readonly calls: ReasoningInvokeInput[] = [];

  async invoke(
    input: ReasoningInvokeInput,
  ): Promise<{ raw: string; modelMeta: ReasoningModelMeta }> {
    this.calls.push(input);
    const { input: agentInput } = parseEnvelope(input);
    return {
      raw: JSON.stringify({
        result: resultFor(agentInput),
        reasoning: { facts: [], decisions: [], assumptions: [], recommendations: [] },
      }),
      modelMeta: { model: LAUNCH_FIXTURE_MODEL, tokensIn: 0, tokensOut: 0, latencyMs: 0 },
    };
  }
}
