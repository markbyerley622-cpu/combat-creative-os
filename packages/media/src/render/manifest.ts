import { z } from 'zod';

/**
 * The render manifest — the complete, validated description of one
 * advertisement, and the only input the FFmpeg renderer accepts.
 *
 * Versioned by a literal discriminator rather than a loose number so a v2
 * manifest fails parsing here instead of being half-understood by a v1
 * renderer. A changed requirement is a new version, never an edit to this
 * one — the same versioned-immutable discipline `DeliveryProfile` and
 * `RoughEditSpecification` follow in `@combat/domain`.
 *
 * Defined in `@combat/media` rather than `@combat/domain` for the same
 * reason `@combat/domain`'s `MediaMetadataSchema` is defined there rather
 * than imported from here: the two packages deliberately do not depend on
 * each other (CLAUDE.md dependency direction), and this is the renderer's
 * provider-neutral input contract, not a persisted domain aggregate. The
 * output block is kept structurally compatible with
 * `DeliveryProfile`/`VERTICAL_SHORT_FORM_V1`, which is what an Activity maps
 * onto it.
 */

/**
 * How a source asset may be used, per docs/aamp-architecture.md §9.1. Only
 * `OWNED` and `LICENSED_FOR_OUTPUT` may reach FFmpeg; `ANALYSIS_ONLY` is the
 * class every Creative Memory reference carries and is rejected before a
 * single frame is decoded.
 */
export const SOURCE_USAGE_CLASSES = ['OWNED', 'LICENSED_FOR_OUTPUT', 'ANALYSIS_ONLY'] as const;
export const SourceUsageClassSchema = z.enum(SOURCE_USAGE_CLASSES);
export type SourceUsageClass = z.infer<typeof SourceUsageClassSchema>;

/** The two classes that may contribute bytes to an output file. */
export const OUTPUT_ELIGIBLE_USAGE_CLASSES: readonly SourceUsageClass[] = [
  'OWNED',
  'LICENSED_FOR_OUTPUT',
];

export const SOURCE_KINDS = ['VIDEO', 'IMAGE', 'AUDIO'] as const;
export const SourceKindSchema = z.enum(SOURCE_KINDS);
export type SourceKind = z.infer<typeof SourceKindSchema>;

/** ISO-8601 instant. Manifests are JSON on disk, so dates cross as strings. */
const IsoDateStringSchema = z.string().datetime({ offset: true }).or(z.string().datetime());

export const SourceLicenseSchema = z
  .object({
    usageClass: SourceUsageClassSchema,
    /** Who holds the rights. Required even for `OWNED` — "Combat Reviews" is an answer. */
    rightsHolder: z.string().min(1),
    /** Mirrors `@combat/domain`'s `LicenseType` values; free-form so a new licence class does not require a media release. */
    licenseType: z.string().min(1),
    /** Absent means perpetual. Present and past means the source is rejected. */
    expiresAt: IsoDateStringSchema.optional(),
    /** Text that must be carried into the export record when the licence demands credit. */
    attribution: z.string().min(1).optional(),
    restrictions: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type SourceLicense = z.infer<typeof SourceLicenseSchema>;

export const RenderSourceSchema = z
  .object({
    /** Manifest-local identifier scenes, overlays and audio tracks refer to. */
    id: z.string().min(1),
    kind: SourceKindSchema,
    /** Absolute, or relative to the manifest file's directory. Containment is enforced at resolution. */
    path: z.string().min(1),
    /** Human-readable role, e.g. "Combat Reviews logo", "app screenshot — fight card". */
    description: z.string().min(1),
    license: SourceLicenseSchema,
    /** Optional expected sha256; a mismatch fails resolution rather than rendering the wrong file. */
    expectedChecksum: z
      .string()
      .regex(/^[0-9a-f]{64}$/, 'expectedChecksum must be a lowercase hex sha256')
      .optional(),
  })
  .strict();
export type RenderSource = z.infer<typeof RenderSourceSchema>;

export const SCENE_MOTIONS = [
  'STATIC',
  'PUSH_IN',
  'PUSH_OUT',
  'PAN_LEFT',
  'PAN_RIGHT',
  /** Layered: a blurred, slower-moving backplate under a sharper foreground moving at a different rate. */
  'PARALLAX',
] as const;
export const SceneMotionSchema = z.enum(SCENE_MOTIONS);
export type SceneMotion = z.infer<typeof SceneMotionSchema>;

export const SCENE_TRANSITIONS = [
  /** Hard cut. Implemented as a one-frame blend so the graph stays a single xfade chain. */
  'CUT',
  'CROSSFADE',
  'DIP_TO_BLACK',
  /** Directional smear standing in for a whip pan's motion blur. */
  'WHIP_PAN',
  /** Two-frame white flash on the cut — the "impact" treatment. */
  'IMPACT_CUT',
  /** Masked UI reveal: the incoming app-interface scene wipes in behind a moving edge. */
  'MASKED_UI_REVEAL',
] as const;
export const SceneTransitionSchema = z.enum(SCENE_TRANSITIONS);
export type SceneTransition = z.infer<typeof SceneTransitionSchema>;

/**
 * Shortest overlap the renderer can express. Every transition is an `xfade`,
 * which needs a non-zero overlap, so even a hard `CUT` is a one-frame blend
 * — which is what a cut looks like at 30 fps anyway, and what keeps the whole
 * timeline a single chain rather than concat runs spliced between fades.
 */
export const MIN_TRANSITION_SECONDS = 1 / 30;

export const SceneTransitionInSchema = z
  .object({
    kind: SceneTransitionSchema,
    /** Overlap with the preceding scene. Counted against the timeline budget. */
    durationSeconds: z
      .number()
      .min(MIN_TRANSITION_SECONDS, 'a transition must overlap by at least one frame')
      .max(3),
  })
  .strict();

export const FramingSchema = z
  .object({
    /**
     * `COVER` fills 1080×1920 and crops the overflow (the default for a
     * landscape clip in a vertical cut); `CONTAIN` fits the whole frame and
     * pads with a blurred backplate rather than hard bars.
     */
    mode: z.enum(['COVER', 'CONTAIN']).default('COVER'),
    /** Crop anchor as a fraction of the overflow, 0.5 being centred. */
    anchorX: z.number().min(0).max(1).default(0.5),
    anchorY: z.number().min(0).max(1).default(0.5),
  })
  .strict();

export const TrimSchema = z
  .object({
    inSeconds: z.number().min(0),
    outSeconds: z.number().positive(),
  })
  .strict()
  .refine((trim) => trim.outSeconds > trim.inSeconds, {
    message: 'trim.outSeconds must be greater than trim.inSeconds',
  });

export const SceneSchema = z
  .object({
    id: z.string().min(1),
    sourceId: z.string().min(1),
    /** Duration on the timeline before transition overlap is subtracted. */
    durationSeconds: z.number().positive(),
    /** Required for a VIDEO source, rejected for a still. */
    trim: TrimSchema.optional(),
    framing: FramingSchema.default({ mode: 'COVER', anchorX: 0.5, anchorY: 0.5 }),
    motion: SceneMotionSchema.default('STATIC'),
    /** 0 is imperceptible, 1 is the strongest move the profile allows. */
    motionIntensity: z.number().min(0).max(1).default(0.5),
    /** Absent on the first scene; required on every later one. */
    transitionIn: SceneTransitionInSchema.optional(),
    /** Whether this scene's own audio is contributed to the mix. */
    useSourceAudio: z.boolean().default(false),
  })
  .strict();
export type Scene = z.infer<typeof SceneSchema>;

export const OVERLAY_ANIMATIONS = ['NONE', 'FADE', 'SLIDE_UP', 'SLIDE_DOWN', 'POP'] as const;
export const OverlayAnimationSchema = z.enum(OVERLAY_ANIMATIONS);
export type OverlayAnimation = z.infer<typeof OverlayAnimationSchema>;

export const OVERLAY_ANCHORS = [
  'TOP_LEFT',
  'TOP_CENTER',
  'TOP_RIGHT',
  'CENTER',
  'BOTTOM_LEFT',
  'BOTTOM_CENTER',
  'BOTTOM_RIGHT',
] as const;
export const OverlayAnchorSchema = z.enum(OVERLAY_ANCHORS);
export type OverlayAnchor = z.infer<typeof OverlayAnchorSchema>;

const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'colour must be #RRGGBB');

export const TextOverlaySchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal('TEXT'),
    text: z.string().min(1).max(200),
    startSeconds: z.number().min(0),
    endSeconds: z.number().positive(),
    anchor: OverlayAnchorSchema.default('CENTER'),
    /** Offset from the anchor, in output pixels. */
    offsetXPx: z.number().int().default(0),
    offsetYPx: z.number().int().default(0),
    fontSizePx: z.number().int().positive().max(300).default(64),
    colorHex: HexColorSchema.default('#FFFFFF'),
    outlineColorHex: HexColorSchema.default('#000000'),
    outlineWidthPx: z.number().int().min(0).max(12).default(3),
    uppercase: z.boolean().default(false),
    animation: OverlayAnimationSchema.default('FADE'),
    animationSeconds: z.number().min(0).max(2).default(0.35),
  })
  .strict();

export const ImageOverlaySchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal('IMAGE'),
    sourceId: z.string().min(1),
    startSeconds: z.number().min(0),
    endSeconds: z.number().positive(),
    anchor: OverlayAnchorSchema.default('TOP_CENTER'),
    offsetXPx: z.number().int().default(0),
    offsetYPx: z.number().int().default(0),
    /** Rendered width; height follows the source aspect ratio. */
    widthPx: z.number().int().positive().max(1080),
    opacity: z.number().min(0).max(1).default(1),
    animation: OverlayAnimationSchema.default('FADE'),
    animationSeconds: z.number().min(0).max(2).default(0.35),
  })
  .strict();

export const OverlaySchema = z.discriminatedUnion('kind', [TextOverlaySchema, ImageOverlaySchema]);
export type Overlay = z.infer<typeof OverlaySchema>;

export const CaptionCueSchema = z
  .object({
    startSeconds: z.number().min(0),
    endSeconds: z.number().positive(),
    text: z.string().min(1).max(240),
  })
  .strict()
  .refine((cue) => cue.endSeconds > cue.startSeconds, {
    message: 'caption cue endSeconds must be greater than startSeconds',
  });
export type CaptionCue = z.infer<typeof CaptionCueSchema>;

export const CaptionStyleSchema = z
  .object({
    fontFamily: z.string().min(1).default('Arial'),
    fontSizePx: z.number().int().positive().max(200).default(56),
    primaryColorHex: HexColorSchema.default('#FFFFFF'),
    outlineColorHex: HexColorSchema.default('#000000'),
    outlineWidthPx: z.number().int().min(0).max(12).default(4),
    bold: z.boolean().default(true),
    uppercase: z.boolean().default(true),
    /** Distance from the bottom safe edge, in output pixels. */
    marginBottomPx: z.number().int().min(0).max(1000).default(420),
    marginHorizontalPx: z.number().int().min(0).max(400).default(96),
  })
  .strict();
export type CaptionStyle = z.infer<typeof CaptionStyleSchema>;

export const CaptionsSchema = z
  .object({
    style: CaptionStyleSchema.default({}),
    cues: z.array(CaptionCueSchema).min(1),
  })
  .strict();

export const BrandingSchema = z
  .object({
    logoSourceId: z.string().min(1),
    anchor: OverlayAnchorSchema.default('TOP_CENTER'),
    offsetXPx: z.number().int().default(0),
    offsetYPx: z.number().int().default(96),
    widthPx: z.number().int().positive().max(1080).default(320),
    opacity: z.number().min(0).max(1).default(0.92),
    /** Windows the logo is on screen. Empty means the whole cut. */
    windows: z
      .array(
        z.object({ startSeconds: z.number().min(0), endSeconds: z.number().positive() }).strict(),
      )
      .default([]),
  })
  .strict();

export const CallToActionSchema = z
  .object({
    headline: z.string().min(1).max(80),
    subline: z.string().min(1).max(120).optional(),
    /** Rendered as a full-bleed end card from here to the end of the cut. */
    startSeconds: z.number().min(0),
    endSeconds: z.number().positive(),
    backgroundHex: HexColorSchema.default('#0B0B0F'),
    headlineColorHex: HexColorSchema.default('#FFFFFF'),
    sublineColorHex: HexColorSchema.default('#FF3B30'),
    /** Optional logo lockup on the card. */
    logoSourceId: z.string().min(1).optional(),
    logoWidthPx: z.number().int().positive().max(1080).default(420),
  })
  .strict()
  .refine((cta) => cta.endSeconds > cta.startSeconds, {
    message: 'cta.endSeconds must be greater than cta.startSeconds',
  });

export const AUDIO_TRACK_ROLES = ['MUSIC', 'VOICEOVER', 'SFX'] as const;
export const AudioTrackRoleSchema = z.enum(AUDIO_TRACK_ROLES);
export type AudioTrackRole = z.infer<typeof AudioTrackRoleSchema>;

export const AudioTrackSchema = z
  .object({
    id: z.string().min(1),
    sourceId: z.string().min(1),
    role: AudioTrackRoleSchema,
    /** Where the track starts on the output timeline. */
    startSeconds: z.number().min(0).default(0),
    /** Offset into the source file. */
    sourceOffsetSeconds: z.number().min(0).default(0),
    gainDb: z.number().min(-60).max(12).default(0),
    fadeInSeconds: z.number().min(0).max(5).default(0),
    fadeOutSeconds: z.number().min(0).max(5).default(0),
    /** Repeat to fill the cut when the source is shorter than the output. */
    loop: z.boolean().default(false),
  })
  .strict();
export type AudioTrack = z.infer<typeof AudioTrackSchema>;

export const LoudnessTargetSchema = z
  .object({
    integratedLufs: z.number().min(-40).max(0).default(-14),
    truePeakDbtp: z.number().min(-9).max(0).default(-1),
    loudnessRange: z.number().positive().max(20).default(11),
  })
  .strict();

export const AudioSchema = z
  .object({
    tracks: z.array(AudioTrackSchema).min(1),
    loudness: LoudnessTargetSchema.default({}),
    /**
     * How far MUSIC is pushed down while a VOICEOVER is present. Applied via
     * sidechain compression keyed on the voice bus, so the duck follows the
     * actual speech envelope rather than a guessed schedule.
     */
    musicDuckingDb: z.number().min(0).max(40).default(12),
  })
  .strict();

export const OutputSpecificationSchema = z
  .object({
    /** Exact target. The renderer proves the produced file matches it. */
    durationSeconds: z.number().positive().max(600),
    aspectRatio: z.literal('9:16'),
    widthPx: z.literal(1080),
    heightPx: z.literal(1920),
    frameRate: z.literal(30),
    container: z.literal('mp4'),
    videoCodec: z.literal('h264'),
    /** Null renders a deliberately silent master with no audio stream at all. */
    audioCodec: z.literal('aac').nullable(),
    pixelFormat: z.literal('yuv420p'),
    /** Duration tolerance for actual-media QA, in frames. */
    durationToleranceFrames: z.number().int().min(0).max(15).default(2),
    /** Delivery profile this manifest was cut against, for provenance. */
    deliveryProfileKey: z.string().min(1).default('VERTICAL_SHORT_FORM_V1'),
    deliveryProfileVersion: z.number().int().positive().default(1),
  })
  .strict();
export type OutputSpecification = z.infer<typeof OutputSpecificationSchema>;

export const RENDER_MANIFEST_VERSION = 1 as const;

const RenderManifestObjectSchema = z
  .object({
    manifestVersion: z.literal(RENDER_MANIFEST_VERSION),
    /** Stable name for this cut; becomes part of the deterministic output filename. */
    name: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'name must be filesystem-safe'),
    campaignId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    campaignPrompt: z.string().min(1).max(4000),
    output: OutputSpecificationSchema,
    sources: z.array(RenderSourceSchema).min(1),
    scenes: z.array(SceneSchema).min(1),
    overlays: z.array(OverlaySchema).default([]),
    captions: CaptionsSchema.optional(),
    branding: BrandingSchema.optional(),
    cta: CallToActionSchema.optional(),
    audio: AudioSchema.optional(),
  })
  .strict();

/**
 * Cross-field rules FFmpeg would otherwise discover the expensive way — a
 * dangling `sourceId`, a timeline whose scenes and transition overlaps do not
 * add up to the requested duration, a CTA scheduled past the end of the cut.
 * All of them are cheaper as parse errors than as a wasted encode.
 */
export const RenderManifestV1Schema = RenderManifestObjectSchema.superRefine((manifest, ctx) => {
  const addIssue = (message: string, path: (string | number)[]): void => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
  };

  const sourceIds = new Set<string>();
  manifest.sources.forEach((source, index) => {
    if (sourceIds.has(source.id)) {
      addIssue(`duplicate source id "${source.id}"`, ['sources', index, 'id']);
    }
    sourceIds.add(source.id);
  });

  const sourcesById = new Map(manifest.sources.map((source) => [source.id, source]));
  const requireSource = (id: string, kind: SourceKind, path: (string | number)[]): void => {
    const source = sourcesById.get(id);
    if (!source) {
      addIssue(`unknown sourceId "${id}"`, path);
      return;
    }
    if (source.kind !== kind) {
      addIssue(`source "${id}" is ${source.kind}, expected ${kind}`, path);
    }
  };

  const sceneIds = new Set<string>();
  manifest.scenes.forEach((scene, index) => {
    if (sceneIds.has(scene.id)) {
      addIssue(`duplicate scene id "${scene.id}"`, ['scenes', index, 'id']);
    }
    sceneIds.add(scene.id);

    const source = sourcesById.get(scene.sourceId);
    if (!source) {
      addIssue(`unknown sourceId "${scene.sourceId}"`, ['scenes', index, 'sourceId']);
    } else if (source.kind === 'AUDIO') {
      addIssue('a scene source must be VIDEO or IMAGE', ['scenes', index, 'sourceId']);
    } else if (source.kind === 'IMAGE' && scene.trim) {
      addIssue('a still-image scene cannot declare a trim range', ['scenes', index, 'trim']);
    } else if (source.kind === 'VIDEO' && !scene.trim) {
      addIssue('a video scene must declare a trim range', ['scenes', index, 'trim']);
    }

    if (scene.trim) {
      const trimmed = scene.trim.outSeconds - scene.trim.inSeconds;
      if (trimmed + 1e-6 < scene.durationSeconds) {
        addIssue(
          `trim range is ${trimmed.toFixed(3)}s but the scene needs ${scene.durationSeconds}s`,
          ['scenes', index, 'trim'],
        );
      }
    }

    if (index === 0 && scene.transitionIn) {
      addIssue('the first scene cannot have a transitionIn', ['scenes', 0, 'transitionIn']);
    }
    if (index > 0 && !scene.transitionIn) {
      addIssue('every scene after the first must declare a transitionIn', [
        'scenes',
        index,
        'transitionIn',
      ]);
    }
    if (scene.transitionIn && scene.transitionIn.durationSeconds >= scene.durationSeconds) {
      addIssue('a transition cannot be as long as the scene it enters', [
        'scenes',
        index,
        'transitionIn',
        'durationSeconds',
      ]);
    }
    if (scene.motion === 'PARALLAX' && source?.kind !== 'IMAGE') {
      addIssue('PARALLAX motion requires a still-image source', ['scenes', index, 'motion']);
    }
  });

  // Exact-duration contract: scenes butt up against each other, transitions
  // overlap. Anything that does not sum to the requested duration is a
  // manifest defect, not something the encoder should paper over.
  const sceneTotal = manifest.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0);
  const overlapTotal = manifest.scenes.reduce(
    (sum, scene) => sum + (scene.transitionIn?.durationSeconds ?? 0),
    0,
  );
  const timelineSeconds = sceneTotal - overlapTotal;
  if (Math.abs(timelineSeconds - manifest.output.durationSeconds) > 1e-6) {
    addIssue(
      `scenes (${sceneTotal}s) minus transition overlaps (${overlapTotal}s) is ${timelineSeconds.toFixed(3)}s, but output.durationSeconds is ${manifest.output.durationSeconds}s`,
      ['scenes'],
    );
  }

  const withinCut = (endSeconds: number, path: (string | number)[], label: string): void => {
    if (endSeconds > manifest.output.durationSeconds + 1e-6) {
      addIssue(
        `${label} ends at ${endSeconds}s, past the ${manifest.output.durationSeconds}s cut`,
        path,
      );
    }
  };

  manifest.overlays.forEach((overlay, index) => {
    if (overlay.endSeconds <= overlay.startSeconds) {
      addIssue('endSeconds must be greater than startSeconds', ['overlays', index, 'endSeconds']);
    }
    withinCut(overlay.endSeconds, ['overlays', index, 'endSeconds'], `overlay "${overlay.id}"`);
    if (overlay.kind === 'IMAGE') {
      requireSource(overlay.sourceId, 'IMAGE', ['overlays', index, 'sourceId']);
    }
  });

  manifest.captions?.cues.forEach((cue, index) => {
    withinCut(cue.endSeconds, ['captions', 'cues', index, 'endSeconds'], `caption cue ${index}`);
  });

  if (manifest.branding) {
    requireSource(manifest.branding.logoSourceId, 'IMAGE', ['branding', 'logoSourceId']);
    manifest.branding.windows.forEach((window, index) => {
      if (window.endSeconds <= window.startSeconds) {
        addIssue('endSeconds must be greater than startSeconds', [
          'branding',
          'windows',
          index,
          'endSeconds',
        ]);
      }
      withinCut(
        window.endSeconds,
        ['branding', 'windows', index, 'endSeconds'],
        `branding window ${index}`,
      );
    });
  }

  if (manifest.cta) {
    withinCut(manifest.cta.endSeconds, ['cta', 'endSeconds'], 'cta');
    if (manifest.cta.logoSourceId) {
      requireSource(manifest.cta.logoSourceId, 'IMAGE', ['cta', 'logoSourceId']);
    }
  }

  if (manifest.audio) {
    if (manifest.output.audioCodec === null) {
      addIssue('audio tracks were supplied but output.audioCodec is null', ['audio', 'tracks']);
    }
    const trackIds = new Set<string>();
    manifest.audio.tracks.forEach((track, index) => {
      if (trackIds.has(track.id)) {
        addIssue(`duplicate audio track id "${track.id}"`, ['audio', 'tracks', index, 'id']);
      }
      trackIds.add(track.id);
      requireSource(track.sourceId, 'AUDIO', ['audio', 'tracks', index, 'sourceId']);
    });
  } else if (manifest.output.audioCodec !== null) {
    const sceneAudio = manifest.scenes.some((scene) => scene.useSourceAudio);
    if (!sceneAudio) {
      addIssue(
        'output.audioCodec requests an audio stream but no audio track or scene audio contributes one',
        ['audio'],
      );
    }
  }
});

export type RenderManifest = z.infer<typeof RenderManifestV1Schema>;

export class ManifestValidationError extends Error {
  constructor(
    public readonly issues: readonly { path: string; message: string }[],
    public readonly manifestPath?: string,
  ) {
    const where = manifestPath ? ` (${manifestPath})` : '';
    super(
      `Render manifest is invalid${where}:\n${issues
        .map((issue) => `  - ${issue.path || '<root>'}: ${issue.message}`)
        .join('\n')}`,
    );
    this.name = 'ManifestValidationError';
  }
}

/**
 * Parses an unknown value (a `JSON.parse` result, an API body) into a
 * `RenderManifest`, or throws `ManifestValidationError` carrying every issue
 * at once rather than the first.
 */
export function parseRenderManifest(value: unknown, manifestPath?: string): RenderManifest {
  const result = RenderManifestV1Schema.safeParse(value);
  if (result.success) return result.data;
  throw new ManifestValidationError(
    result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
    manifestPath,
  );
}

/** Frames are the timeline's real unit; seconds are the manifest's. */
export function secondsToFrames(seconds: number, frameRate: number): number {
  return Math.round(seconds * frameRate);
}
