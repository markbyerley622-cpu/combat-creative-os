/**
 * The LTX camera-motion serialization boundary.
 *
 * AAMP's motion vocabulary is provider-neutral and stays that way. It describes
 * moves in the language a storyboard is written in — a slow push, a lateral
 * track, a handheld drift — and it is not narrowed because one vendor's API
 * happens to accept eight strings. This module is the one place those two
 * vocabularies meet, and it translates in exactly one direction: internal name
 * in, official LTX value out.
 *
 * **The live API supplied this list.** A submission carrying `SLOW_PUSH_IN`
 * was answered `HTTP 400: Invalid input for 'camera_motion'` before a job
 * existed, naming the eight values below. They are transcribed from that
 * response rather than guessed.
 *
 * ## What is mapped, and why each one is defensible
 *
 * A mapping is only made when the two names describe **the same physical
 * camera move**. That standard is deliberately strict, because the alternative
 * — picking the nearest-looking value — silently sends a different shot from
 * the one the storyboard approved, and it does so in a field nobody reads back.
 *
 * - `SLOW_PUSH_IN` → `dolly_in`, `SLOW_PULL_OUT` → `dolly_out`. A push and a
 *   pull *are* a dolly along the lens axis. "Slow" is a quality of the move,
 *   not a different move, and it stays where it belongs: in the prose prompt.
 *   No speed, strength or intensity field is invented to carry it, because the
 *   API defines none and a fabricated field is a guess with a number in it.
 * - `LATERAL_TRACK_LEFT` / `LATERAL_TRACK_RIGHT` → `dolly_left` / `dolly_right`.
 *   Tracking laterally and dollying sideways are the same translation; the two
 *   words are used interchangeably on a set.
 * - `STATIC` → `static`. A locked-off camera.
 *
 * ## What is refused, and why refusing is the correct answer
 *
 * - `HANDHELD_DRIFT` and `ORBIT_LEFT` / `ORBIT_RIGHT` have no counterpart at
 *   all. There is no arc in the LTX vocabulary and no handheld quality.
 * - `TILT_UP` and `TILT_DOWN` are refused too, and this is the subtle one. A
 *   **tilt** rotates the camera about its horizontal axis from a fixed
 *   position; a **jib** raises or lowers the whole camera. They point at
 *   different things and reveal different geometry. `jib_up` is the nearest
 *   *looking* value and it is not the same move, so it is not a defensible
 *   equivalent and it is not used.
 *
 * A refused value is a typed failure raised **before any network access** —
 * before the upload, before the submission, before a byte leaves this process.
 * It names the value and names `ltx-hosted`, so an operator reads which move
 * this provider cannot express rather than "generation failed". It is never
 * silently omitted, never replaced with `static`, and never left to the prompt
 * wording to imply: a prompt saying "the camera arcs left" while the structured
 * field says nothing is a request whose two halves disagree, and the model is
 * free to follow either.
 *
 * ## `CRANE_DOWN`
 *
 * Considered and deliberately **not** added. It is not a member of
 * `CAMERA_MOTIONS` and no internal contract defines it, so there is nothing to
 * map: the condition for mapping it to `jib_down` — an internal contract
 * defining it as a vertical camera descent — is not met, because the internal
 * contract does not define it at all. Should it ever be added as a vertical
 * descent of the camera body, `jib_down` would be its defensible equivalent and
 * this table is where that decision would be recorded. Until then it takes the
 * same path as any unrecognised value: a typed refusal.
 */

/** Bumped whenever a mapping is added, removed or changed. Travels in the refusal. */
export const LTX_CAMERA_MOTION_PROFILE_VERSION = 1 as const;

/**
 * The only values `camera_motion` may carry on the wire.
 *
 * Transcribed verbatim from the live API's own 400 response. This is a closed
 * set: a value not in it is refused here rather than discovered from an HTTP
 * error after an image has already been uploaded.
 */
export const LTX_CAMERA_MOTIONS = [
  'dolly_in',
  'dolly_out',
  'dolly_left',
  'dolly_right',
  'jib_up',
  'jib_down',
  'static',
  'focus_shift',
] as const;
export type LtxCameraMotion = (typeof LTX_CAMERA_MOTIONS)[number];

/**
 * Internal name to official LTX value.
 *
 * Every entry is the *same move under two names*. A `Map` rather than an object
 * literal so a prototype key can never be mistaken for a mapping.
 */
export const LTX_CAMERA_MOTION_MAP: ReadonlyMap<string, LtxCameraMotion> = new Map([
  ['STATIC', 'static'],
  ['SLOW_PUSH_IN', 'dolly_in'],
  ['SLOW_PULL_OUT', 'dolly_out'],
  ['LATERAL_TRACK_LEFT', 'dolly_left'],
  ['LATERAL_TRACK_RIGHT', 'dolly_right'],
] as const);

/**
 * Internal values this provider cannot express, each with the reason a person
 * needs in order to decide what to do instead.
 *
 * Listed explicitly rather than left to fall through the "unknown value" path,
 * because "ORBIT_LEFT is not a value this API knows" and "ORBIT_LEFT is a typo"
 * are different problems with different fixes.
 */
export const LTX_UNSUPPORTED_CAMERA_MOTIONS: ReadonlyMap<string, string> = new Map([
  [
    'HANDHELD_DRIFT',
    'the LTX vocabulary has no handheld quality; every value it accepts is a clean mechanical move',
  ],
  ['ORBIT_LEFT', 'the LTX vocabulary contains no arc or orbit around the subject'],
  ['ORBIT_RIGHT', 'the LTX vocabulary contains no arc or orbit around the subject'],
  [
    'TILT_UP',
    'a tilt rotates the camera from a fixed position; jib_up raises the whole camera. They are different moves, and the nearest-looking value is not a substitute',
  ],
  [
    'TILT_DOWN',
    'a tilt rotates the camera from a fixed position; jib_down lowers the whole camera. They are different moves, and the nearest-looking value is not a substitute',
  ],
]);

export class LtxCameraMotionError extends Error {
  readonly kind = 'UNSUPPORTED_PROVIDER_CAMERA_MOTION' as const;
  readonly providerName = 'ltx-hosted' as const;

  constructor(
    /** The internal value that could not be expressed. */
    public readonly requestedCameraMotion: string,
    message: string,
  ) {
    super(message);
    this.name = 'LtxCameraMotionError';
  }
}

export function isLtxCameraMotion(value: string): value is LtxCameraMotion {
  return (LTX_CAMERA_MOTIONS as readonly string[]).includes(value);
}

/**
 * Translates one internal camera motion into its official LTX value.
 *
 * Called before the upload, so a scene this provider cannot express costs
 * nothing and transfers nothing. An already-official value passes through
 * unchanged — the boundary is idempotent, which matters because a caller that
 * translated once and is asked again should not be punished for it.
 */
export function toLtxCameraMotion(internal: string): LtxCameraMotion {
  const trimmed = internal.trim();
  if (trimmed.length === 0) {
    throw new LtxCameraMotionError(
      internal,
      'an empty camera motion was supplied. ltx-hosted requires one of ' +
        `${LTX_CAMERA_MOTIONS.join(', ')}, and no value is silently omitted.`,
    );
  }

  const mapped = LTX_CAMERA_MOTION_MAP.get(trimmed);
  if (mapped) return mapped;
  if (isLtxCameraMotion(trimmed)) return trimmed;

  const knownReason = LTX_UNSUPPORTED_CAMERA_MOTIONS.get(trimmed);
  if (knownReason) {
    throw new LtxCameraMotionError(
      trimmed,
      `"${trimmed}" cannot be expressed by ltx-hosted: ${knownReason}. It is refused rather than omitted or replaced with "static" — a request whose structured field and prose disagree lets the model follow either. Supported by this provider: ${[
        ...LTX_CAMERA_MOTION_MAP.keys(),
      ].join(', ')}. (camera-motion profile v${LTX_CAMERA_MOTION_PROFILE_VERSION})`,
    );
  }

  throw new LtxCameraMotionError(
    trimmed,
    `"${trimmed}" is not a camera motion ltx-hosted recognises. Supported: ${[
      ...LTX_CAMERA_MOTION_MAP.keys(),
    ].join(', ')}; the provider's own values are ${LTX_CAMERA_MOTIONS.join(
      ', ',
    )}. (camera-motion profile v${LTX_CAMERA_MOTION_PROFILE_VERSION})`,
  );
}
