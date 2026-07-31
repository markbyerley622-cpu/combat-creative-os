/**
 * Typed failures and exit codes for the storyboard-to-video path.
 *
 * A dedicated table rather than an extension of `EXIT_CODES`, because these
 * are a different kind of failure from a campaign run's. A script driving this
 * command needs to tell "the cost ceiling refused it" from "the upload failed"
 * from "the model produced something unplayable" without parsing prose — those
 * three need three completely different responses, and only one of them is
 * worth retrying.
 *
 * The numbering starts at 20 so it can never collide with `EXIT_CODES`, whose
 * highest member is 12. Two values are deliberately shared with it: 0 for
 * success and 2 for an invalid invocation, because those mean the same thing
 * everywhere in this repository.
 */

export const STORYBOARD_VIDEO_EXIT_CODES = {
  SUCCESS: 0,
  /** Bad flags, unknown option, missing required argument. */
  INVALID_ARGUMENTS: 2,

  /** The storyboard package or the scene manifest is not usable. */
  INVALID_STORYBOARD: 20,
  /** An authoritative FRAME-XX keyframe is missing, ambiguous or undecodable. */
  MISSING_FRAME: 21,
  /** A model name, resolution, frame rate or duration this milestone does not support. */
  UNSUPPORTED_MODEL_OR_DURATION: 22,
  /** `LTXV_API_KEY` is absent and the run needs a paid generation. */
  MISSING_API_KEY: 23,
  /** The computed maximum exceeds `--max-cost-cents`. Nothing was uploaded. */
  COST_CEILING_EXCEEDED: 24,
  /** The signed PUT of a start frame failed. */
  UPLOAD_FAILED: 25,
  /** `POST /v2/image-to-video` was refused. */
  JOB_SUBMISSION_FAILED: 26,
  /** HTTP 402 — quota or billing refused the call. */
  PAYMENT_REQUIRED: 27,
  /** HTTP 429. Never retried automatically. */
  RATE_LIMITED: 28,
  /** The provider reported the job failed. */
  GENERATION_FAILED: 29,
  /** The end-to-end deadline elapsed with the job unfinished. */
  POLLING_TIMEOUT: 30,
  /** A response body this client does not recognise. */
  MALFORMED_RESPONSE: 31,
  /** The result URL was gone before the bytes were retrieved. */
  EXPIRED_RESULT: 32,
  /** The result download failed for any other reason. */
  DOWNLOAD_FAILED: 33,
  /** Bytes arrived but are not a playable clip at the required geometry. */
  INVALID_GENERATED_MEDIA: 34,
  /** No usable source could be resolved for a scene that requires a moving one. */
  NO_USABLE_SOURCE: 35,
  /** FFmpeg, staging or the preview path failed. */
  FINAL_RENDER_FAILURE: 36,
  /** The finished master failed actual-media QA or storyboard fidelity. */
  QA_FAILURE: 37,
  /**
   * A required moving scene has no standing human approval — never reviewed,
   * rejected, or approved against a clip that has since changed. Nothing was
   * composited: the gate runs before FFmpeg.
   */
  MOTION_REVIEW_BLOCKED: 38,
  /**
   * A required moving scene's clip failed local technical inspection. A
   * different clip is needed; no approval can clear this.
   */
  MOTION_INSPECTION_FAILED: 39,
  /**
   * A routed scene's authored second stage cannot be executed as written —
   * too few frames to move across, a frame size that is not one, or a
   * compiled chain reaching for a filter this treatment may not emit.
   *
   * Distinct from a render failure because the fix is different: this is a
   * plan that has to be edited, not a pipeline that has to be rerun.
   */
  POST_MOTION_NOT_EXECUTABLE: 40,
  /**
   * The authored move at the authored magnitude would crop the region the
   * scene says must survive. Refused before FFmpeg; nothing was rendered.
   */
  POST_MOTION_WOULD_CROP_PRESERVED_REGION: 41,
  /**
   * The ten authoritative plates could not be staged as run-owned
   * `FRAME-01` … `FRAME-10` copies — missing, ambiguous, landscape, or a
   * copy that did not hash to its source.
   */
  PLATE_STAGING_FAILED: 42,
} as const;

export type StoryboardVideoExitCode =
  (typeof STORYBOARD_VIDEO_EXIT_CODES)[keyof typeof STORYBOARD_VIDEO_EXIT_CODES];

export const STORYBOARD_VIDEO_FAILURE_KINDS = [
  'INVALID_ARGUMENTS',
  'INVALID_STORYBOARD',
  'MISSING_FRAME',
  'UNSUPPORTED_MODEL_OR_DURATION',
  'MISSING_API_KEY',
  'COST_CEILING_EXCEEDED',
  'UPLOAD_FAILED',
  'JOB_SUBMISSION_FAILED',
  'PAYMENT_REQUIRED',
  'RATE_LIMITED',
  'GENERATION_FAILED',
  'POLLING_TIMEOUT',
  'MALFORMED_RESPONSE',
  'EXPIRED_RESULT',
  'DOWNLOAD_FAILED',
  'INVALID_GENERATED_MEDIA',
  'NO_USABLE_SOURCE',
  'FINAL_RENDER_FAILURE',
  'QA_FAILURE',
  'MOTION_REVIEW_BLOCKED',
  'MOTION_INSPECTION_FAILED',
  'POST_MOTION_NOT_EXECUTABLE',
  'POST_MOTION_WOULD_CROP_PRESERVED_REGION',
  'PLATE_STAGING_FAILED',
] as const;
export type StoryboardVideoFailureKind = (typeof STORYBOARD_VIDEO_FAILURE_KINDS)[number];

export class StoryboardVideoError extends Error {
  constructor(
    public readonly kind: StoryboardVideoFailureKind,
    message: string,
    /** The scene this failed on, when it failed on one. */
    public readonly sceneNumber?: number,
  ) {
    super(message);
    this.name = 'StoryboardVideoError';
  }

  get exitCode(): StoryboardVideoExitCode {
    return STORYBOARD_VIDEO_EXIT_CODES[this.kind];
  }
}

/** Every kind maps to exactly one code, and the map is total. Asserted by a test. */
export function exitCodeForFailure(kind: StoryboardVideoFailureKind): StoryboardVideoExitCode {
  return STORYBOARD_VIDEO_EXIT_CODES[kind];
}
