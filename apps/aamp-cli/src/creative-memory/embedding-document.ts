import type { PacingProfile } from '@combat/domain';
import type { ProviderEmbeddingInput } from '@combat/providers';

/**
 * Builds the deterministic text document a scene is embedded from.
 *
 * Two rules shape it. **Nothing is invented** — a field absent from the
 * database is absent from the document, never filled with a plausible default,
 * because a fabricated annotation would then be retrieved and studied as if a
 * reviewer had written it. **Nothing expressive is indexed** — the document
 * carries measurements, categories and the reviewer's *abstractions*, never
 * the advertisement's own copy, transcript or dialogue. Retrieval works on
 * what a reference teaches, not on what it says.
 *
 * `contributingFields` records exactly which fields were used, and feeds the
 * input hash: changing any of them changes the hash, which is how the index
 * knows a vector has gone stale.
 */

export interface SceneDocumentSource {
  readonly referenceId: string;
  readonly sceneId: string;
  readonly roleTags: readonly string[];
  readonly platform?: string;
  readonly sceneIndex: number;
  readonly sceneStartSeconds: number;
  readonly sceneDurationSeconds: number;
  readonly advertisementDurationSeconds: number;
  readonly sceneCount: number;
  readonly cutsPerSecond: number;
  readonly averageSceneSeconds?: number;
  readonly firstCutSeconds?: number;
  readonly aspectRatio: string;
  readonly hasAudio: boolean;
  /** Reviewed, approved annotation fields. Absent when unreviewed. */
  readonly hookMechanism?: string;
  readonly narrativeStructure?: string;
  readonly cameraMovement?: string;
  readonly transitionCategory?: string;
  readonly typographyBehaviour?: string;
  readonly soundProgression?: string;
  readonly emotionalMechanism?: string;
  readonly platformNativeCharacteristics?: string;
  readonly audienceTension?: string;
  readonly campaignProposition?: string;
  readonly productRevealSeconds?: number;
  readonly ctaSeconds?: number;
  readonly transferablePrinciple?: string;
  /**
   * Whether a transcript genuinely exists. Only a *summary length* signal is
   * indexed — never the transcript text, which is the advertisement's own
   * words.
   */
  readonly transcriptSegmentCount?: number;
  /** Analysis frame paths, for image-capable profiles only. */
  readonly framePaths?: readonly string[];
}

/** Pacing band from measured cut density. A measurement, not a judgement. */
export function pacingFor(cutsPerSecond: number): PacingProfile {
  if (cutsPerSecond >= 0.8) return 'VERY_FAST';
  if (cutsPerSecond >= 0.4) return 'FAST';
  if (cutsPerSecond >= 0.15) return 'MEASURED';
  return 'SLOW';
}

/**
 * Renders the document.
 *
 * Numeric facts are emitted as `key=value` so the structural embedder can
 * parse them into its numeric block, and prose abstractions follow as free
 * text for the term block. The ordering is fixed so the same scene always
 * renders identically.
 */
export function buildSceneEmbeddingDocument(source: SceneDocumentSource): ProviderEmbeddingInput {
  const contributingFields: string[] = [];
  const lines: string[] = [];

  const add = (field: string, line: string): void => {
    contributingFields.push(field);
    lines.push(line);
  };
  const addIfPresent = (field: string, value: string | number | undefined, line: string): void => {
    if (value === undefined || value === '') return;
    add(field, line);
  };

  add('roleTags', `roles: ${[...source.roleTags].sort().join(' ')}`);
  addIfPresent('platform', source.platform, `platform: ${source.platform}`);

  // Measured structure, in the parseable form the structural block reads.
  add('sceneDurationSeconds', `sceneDurationSeconds=${source.sceneDurationSeconds.toFixed(3)}`);
  add(
    'advertisementDurationSeconds',
    `advertisementDurationSeconds=${source.advertisementDurationSeconds.toFixed(3)}`,
  );
  add('sceneCount', `sceneCount=${source.sceneCount}`);
  add('cutsPerSecond', `cutsPerSecond=${source.cutsPerSecond.toFixed(4)}`);
  add('aspectRatio', `aspectRatio=${source.aspectRatio}`);
  add('pacing', `pacing: ${pacingFor(source.cutsPerSecond).toLowerCase().replace('_', ' ')}`);
  addIfPresent(
    'averageSceneSeconds',
    source.averageSceneSeconds,
    `averageSceneSeconds=${source.averageSceneSeconds?.toFixed(3)}`,
  );
  addIfPresent(
    'firstCutSeconds',
    source.firstCutSeconds,
    `firstCutSeconds=${source.firstCutSeconds?.toFixed(3)}`,
  );
  addIfPresent(
    'productRevealSeconds',
    source.productRevealSeconds,
    `productRevealSeconds=${source.productRevealSeconds?.toFixed(3)}`,
  );
  addIfPresent('ctaSeconds', source.ctaSeconds, `ctaSeconds=${source.ctaSeconds?.toFixed(3)}`);
  add('hasAudio', `hasAudio=${source.hasAudio ? 1 : 0}`);

  // Reviewer abstractions. Never the advertisement's own words.
  addIfPresent('hookMechanism', source.hookMechanism, `hook: ${source.hookMechanism}`);
  addIfPresent(
    'narrativeStructure',
    source.narrativeStructure,
    `narrative: ${source.narrativeStructure}`,
  );
  addIfPresent('cameraMovement', source.cameraMovement, `camera: ${source.cameraMovement}`);
  addIfPresent(
    'transitionCategory',
    source.transitionCategory,
    `transitions: ${source.transitionCategory}`,
  );
  addIfPresent(
    'typographyBehaviour',
    source.typographyBehaviour,
    `typography: ${source.typographyBehaviour}`,
  );
  addIfPresent('soundProgression', source.soundProgression, `sound: ${source.soundProgression}`);
  addIfPresent(
    'emotionalMechanism',
    source.emotionalMechanism,
    `emotional mechanism: ${source.emotionalMechanism}`,
  );
  addIfPresent(
    'platformNativeCharacteristics',
    source.platformNativeCharacteristics,
    `platform-native: ${source.platformNativeCharacteristics}`,
  );
  addIfPresent(
    'audienceTension',
    source.audienceTension,
    `audience tension: ${source.audienceTension}`,
  );
  addIfPresent(
    'campaignProposition',
    source.campaignProposition,
    `proposition: ${source.campaignProposition}`,
  );
  addIfPresent(
    'transferablePrinciple',
    source.transferablePrinciple,
    `principle: ${source.transferablePrinciple}`,
  );

  // Only that a transcript exists and how long it is — never its content.
  addIfPresent(
    'transcriptSegmentCount',
    source.transcriptSegmentCount,
    `transcriptSegments=${source.transcriptSegmentCount}`,
  );

  return {
    text: lines.join('\n'),
    imagePaths: source.framePaths ? [...source.framePaths] : [],
    instruction: 'Represent this advertising reference scene for craft-similarity retrieval',
    contributingFields,
  };
}

/**
 * Renders a search query into the same vocabulary the documents use.
 *
 * The structured filters are appended as text as well as being applied as
 * Qdrant filters, so a query asking for "fast pacing" matches a document that
 * measured fast pacing even when the words differ.
 */
export function buildQueryDocument(
  query: string,
  filter: {
    businessRole?: string;
    platform?: string;
    targetDurationSeconds?: number;
    desiredPacing?: string;
    desiredHook?: string;
    narrativeStage?: string;
  },
): ProviderEmbeddingInput {
  const contributingFields = ['query'];
  const lines = [query];

  const append = (field: string, line: string): void => {
    contributingFields.push(field);
    lines.push(line);
  };

  if (filter.businessRole) append('businessRole', `roles: ${filter.businessRole}`);
  if (filter.platform) append('platform', `platform: ${filter.platform}`);
  if (filter.desiredPacing) {
    append('desiredPacing', `pacing: ${filter.desiredPacing.toLowerCase().replace('_', ' ')}`);
    // Mirror the numeric band so the structured block agrees with the words.
    const representative: Record<string, number> = {
      VERY_FAST: 1.0,
      FAST: 0.6,
      MEASURED: 0.25,
      SLOW: 0.08,
    };
    append(
      'desiredPacingNumeric',
      `cutsPerSecond=${(representative[filter.desiredPacing] ?? 0.3).toFixed(4)}`,
    );
  }
  if (filter.desiredHook)
    append('desiredHook', `hook: ${filter.desiredHook.toLowerCase().replace(/_/g, ' ')}`);
  if (filter.narrativeStage) {
    append(
      'narrativeStage',
      `narrative: ${filter.narrativeStage.toLowerCase().replace(/_/g, ' ')}`,
    );
  }
  if (filter.targetDurationSeconds !== undefined) {
    append(
      'targetDurationSeconds',
      `advertisementDurationSeconds=${filter.targetDurationSeconds.toFixed(3)}`,
    );
  }

  return {
    text: lines.join('\n'),
    imagePaths: [],
    instruction: 'Represent this creative brief for advertising reference retrieval',
    contributingFields,
  };
}
