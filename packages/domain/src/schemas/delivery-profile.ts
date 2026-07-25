import { z } from 'zod';
import { AspectRatioSchema, DeliveryPlatformSchema, TextSafeAreaSchema } from './shared-enums';

/**
 * M12 — the named, versioned delivery profile a campaign's variants are cut
 * and judged against. This is the entity that **resolves**
 * docs/architecture.md §7.2 open question 5 ("target platforms/aspect ratios
 * aren't specified beyond the three durations"), which blocked M12.
 *
 * A `DeliveryProfile` is the platform-family-level contract (one vertical
 * short-form profile covering Reels/TikTok/Shorts, since all three share
 * 1080×1920 / 9:16 / 30fps / captions-on delivery); the existing
 * `DeliverySpecification` stays the per-platform row derived from it, so a
 * `CreativeVariant` keeps its `deliverySpecificationId` FK unchanged.
 *
 * Immutable once created: a changed requirement is a new `version` (and, when
 * the requirements change meaningfully, a new `key`), never an edit — the same
 * versioned-immutable discipline `RoughEditSpecification`/`SoundDesignPlan`
 * follow, and what lets a `VariantSpecification` pin the exact profile version
 * its cut points were computed against.
 */
export const DeliveryProfileSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  /** Stable identifier for the profile family, e.g. `VERTICAL_SHORT_FORM_V1`. */
  key: z.string().min(1),
  version: z.number().int().positive(),
  displayName: z.string().min(1),
  platforms: z.array(DeliveryPlatformSchema).min(1),
  aspectRatio: AspectRatioSchema,
  resolutionWidth: z.number().int().positive(),
  resolutionHeight: z.number().int().positive(),
  frameRate: z.number().int().positive(),
  /** Target durations, longest first — one `VariantSpecification` per entry. */
  durationsSeconds: z.array(z.number().int().positive()).min(1),
  captionBurnRequired: z.boolean(),
  /**
   * Which safe areas overlay/caption/CTA content must stay inside.
   * Configurable per profile rather than hardcoded in the cut-point validator.
   */
  safeAreas: z.array(TextSafeAreaSchema).min(1),
  /**
   * The CTA must remain visible within this many seconds of the variant's end,
   * for every variant long enough to contain a CTA at all (see
   * `ctaMinimumDurationSeconds`). Undefined disables the rule.
   */
  ctaTailSeconds: z.number().int().positive().optional(),
  /**
   * Shortest target duration the CTA-tail rule is enforced at. A 6s cutdown
   * that cannot fit its hook *and* a CTA in the tail is not failed by the rule
   * — "where duration permits", per the M12 profile decision.
   */
  ctaMinimumDurationSeconds: z.number().int().positive().optional(),
  /** Frame tolerance a rendered variant's duration may differ from target by. */
  durationToleranceFrames: z.number().int().nonnegative(),
  createdAt: z.date(),
});
export type DeliveryProfile = z.infer<typeof DeliveryProfileSchema>;

/** The content fields a caller supplies when seeding a profile (ids/timestamps assigned at persistence). */
export type DeliveryProfileContent = Omit<DeliveryProfile, 'id' | 'workspaceId' | 'createdAt'>;

/**
 * **VERTICAL_SHORT_FORM_V1 — the M12 default delivery profile**, and the
 * resolution of §7.2 open question 5. Instagram Reels / TikTok / YouTube
 * Shorts share one vertical delivery contract, so one profile covers all
 * three rather than three near-identical rows:
 *
 * - 1080×1920, 9:16, 30fps
 * - burned-in captions required
 * - safe-area metadata required on every variant (configurable here, not
 *   hardcoded in the validator)
 * - durations 15s / 10s / 6s
 * - the CTA must remain visible in the final two seconds, for any variant of
 *   at least 10s (`ctaMinimumDurationSeconds`) — the 6s cutdown is exempt,
 *   which is what "where duration permits" means operationally
 *
 * `durationToleranceFrames: 0` — cut points are computed from persisted
 * `Timeline` frame boundaries, so an exact frame match is achievable and
 * anything else indicates a real defect rather than rounding.
 */
export const VERTICAL_SHORT_FORM_V1: DeliveryProfileContent = {
  key: 'VERTICAL_SHORT_FORM_V1',
  version: 1,
  displayName: 'Vertical short form (Reels / TikTok / Shorts)',
  platforms: ['INSTAGRAM_REELS', 'TIKTOK', 'YOUTUBE_SHORTS'],
  aspectRatio: '9:16',
  resolutionWidth: 1080,
  resolutionHeight: 1920,
  frameRate: 30,
  durationsSeconds: [15, 10, 6],
  captionBurnRequired: true,
  safeAreas: ['TOP', 'BOTTOM', 'CENTER'],
  ctaTailSeconds: 2,
  ctaMinimumDurationSeconds: 10,
  durationToleranceFrames: 0,
};

/** Every built-in profile, keyed by `key`. Seeded per workspace by the API/worker, never hardcoded into an Activity's logic. */
export const BUILT_IN_DELIVERY_PROFILES: readonly DeliveryProfileContent[] = [
  VERTICAL_SHORT_FORM_V1,
];
