import type { ReferenceImageInput, ReferenceUsageClass } from '../video-generation';
import { VideoGenerationError } from '../video-generation';

/**
 * The rights gate for generation *inputs*.
 *
 * `@combat/media`'s `source-resolution.ts` is the equivalent gate for render
 * inputs, and the two enforce the same principle at the two points where bytes
 * leave this system's control: nothing reaches a third-party model, and nothing
 * reaches FFmpeg, unless we can name who holds the rights and what they permit.
 *
 * This one runs *before* any upload, so an `ANALYSIS_ONLY` reference is refused
 * while it is still an object in memory — it never becomes an HTTP body.
 */

/** Classes that may be transmitted to a generation provider. */
const GENERATION_ELIGIBLE_CLASSES: readonly ReferenceUsageClass[] = [
  'OWNED',
  'LICENSED_FOR_OUTPUT',
  'GENERATED',
];

export interface ReferenceRightsContext {
  /** Instant licence expiry is measured against. Supplied by the caller — never `Date.now()` here. */
  readonly now: Date;
}

function refuse(message: string): never {
  throw new VideoGenerationError({
    reason: 'PROVIDER_REJECTED',
    retryable: false,
    message,
  });
}

/**
 * Throws unless this reference may legally be sent to a generation provider.
 *
 * Fails closed in both directions: an absent `rights` block is refused (we
 * cannot prove permission we never recorded), and an unrecognised usage class
 * is refused rather than defaulted. The refusal is non-retryable — a retry
 * would transmit the same forbidden bytes.
 */
export function assertReferenceMayBeGenerationInput(
  reference: ReferenceImageInput,
  context: ReferenceRightsContext,
): void {
  const rights = reference.rights;
  if (!rights) {
    refuse(
      `Reference asset ${reference.assetId} carries no rights metadata — refusing to transmit it to a generation provider`,
    );
  }

  if (rights.usageClass === 'ANALYSIS_ONLY') {
    refuse(
      `Reference asset ${reference.assetId} is ANALYSIS_ONLY — it may be studied for structure and pacing but never sent as generation input`,
    );
  }

  if (!GENERATION_ELIGIBLE_CLASSES.includes(rights.usageClass)) {
    refuse(
      `Reference asset ${reference.assetId} has usage class "${rights.usageClass}", which is not eligible as generation input`,
    );
  }

  if (!rights.rightsHolder.trim()) {
    refuse(`Reference asset ${reference.assetId} names no rights holder`);
  }

  if (rights.expiresAt !== undefined) {
    const expiry = new Date(rights.expiresAt);
    if (Number.isNaN(expiry.getTime())) {
      refuse(
        `Reference asset ${reference.assetId} has an unparseable licence expiry "${rights.expiresAt}"`,
      );
    }
    if (expiry.getTime() <= context.now.getTime()) {
      refuse(
        `Reference asset ${reference.assetId}'s licence expired at ${expiry.toISOString()} — refusing to use it as generation input`,
      );
    }
  }
}

/**
 * Gates a whole reference set and returns the ones that may be transmitted,
 * in input order. Throws on the first refusal rather than silently dropping —
 * quietly generating without a reference the director asked for would produce
 * a shot nobody requested.
 */
export function gateReferenceImages(
  references: readonly ReferenceImageInput[],
  context: ReferenceRightsContext,
): readonly ReferenceImageInput[] {
  for (const reference of references) {
    assertReferenceMayBeGenerationInput(reference, context);
  }
  return references;
}

/** The provenance rows recorded against every candidate this generation produces. */
export function describeReferenceProvenance(
  references: readonly ReferenceImageInput[],
): readonly { assetId: string; role: string; usageClass: string }[] {
  return references.map((reference) => ({
    assetId: reference.assetId,
    role: reference.role ?? 'STYLE',
    usageClass: reference.rights?.usageClass ?? 'UNKNOWN',
  }));
}
