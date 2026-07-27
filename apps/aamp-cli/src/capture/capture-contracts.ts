import { z } from 'zod';

/**
 * Typed contracts for read-only capture of approved public Combat Reviews
 * screens, and their conversion into rights-controlled production assets.
 *
 * Three things this module exists to make structurally true.
 *
 * **A URL is not a licence.** Reaching a page over HTTP establishes that it is
 * public, and nothing else. Output eligibility comes from a separate,
 * human-authored `AppCaptureRightsDeclaration` naming a person, a basis, a
 * territory and a term. Without one a capture still runs — inspection is
 * useful — but every asset it produces is `REVIEW_REQUIRED` and cannot be
 * spelled in a way the production-asset manifest accepts.
 *
 * **Capture is read-only by construction, not by intention.** The adapter
 * allows GET and HEAD, refuses every other method, refuses cross-origin
 * navigation, downloads, popups and form submission, and only ever visits the
 * screens declared here. The public Combat Reviews site fires its own
 * `POST /api/track` and presence beacons on load; those are aborted and
 * counted, and the page still renders.
 *
 * **User-written content is off by default.** `APP_DISCUSSION_SANITISED` is
 * the only role that may show community writing, and a screen carrying it is
 * disabled unless a specification opts in *explicitly* — omitting `enabled`
 * leaves it off. Every other screen has user content redacted before the
 * shutter opens.
 */

export const APP_CAPTURE_CONTRACT_VERSION = 1 as const;

/**
 * What a captured screen depicts.
 *
 * Deliberately about the *screen*, not about the manifest slot it will fill.
 * An operator merging a capture into the committed preview manifest keeps the
 * plan's asset ids; the role stays an honest description of what was
 * photographed, so a report never claims a screen showed something it did not.
 */
export const APP_CAPTURE_ROLES = [
  'APP_EVENT_LIST',
  'APP_EVENT_DETAIL',
  'APP_SCHEDULE',
  'APP_FIGHT_CARD',
  'APP_PREDICTION',
  'APP_DISCUSSION_SANITISED',
] as const;
export const AppCaptureRoleSchema = z.enum(APP_CAPTURE_ROLES);
export type AppCaptureRole = z.infer<typeof AppCaptureRoleSchema>;

/**
 * Roles a specification must switch on by name.
 *
 * `enabled` is optional precisely so that its *absence* is a decision: a
 * discussion screen nobody thought about is a discussion screen that does not
 * run. Making the field required would turn "off by default" into "off if the
 * author remembered", which is not the same guarantee.
 */
export const ROLES_DISABLED_BY_DEFAULT: readonly AppCaptureRole[] = ['APP_DISCUSSION_SANITISED'];

export function isEnabledByDefault(role: AppCaptureRole): boolean {
  return !ROLES_DISABLED_BY_DEFAULT.includes(role);
}

/**
 * Viewport presets, chosen so a screenshot is delivery-shaped rather than
 * cropped into shape afterwards.
 *
 * `PHONE_PORTRAIT_1080X1920` is 360×640 CSS pixels at a device scale factor of
 * 3, which lands on exactly 1080×1920 — the delivery geometry the renderer
 * already targets, so the still needs no rescale and loses nothing. The taller
 * presets match current handsets and are cropped COVER by the renderer.
 */
export const VIEWPORT_PRESETS = {
  PHONE_PORTRAIT_1080X1920: { widthCssPx: 360, heightCssPx: 640, deviceScaleFactor: 3 },
  PHONE_PORTRAIT_1080X2400: { widthCssPx: 360, heightCssPx: 800, deviceScaleFactor: 3 },
  PHONE_PORTRAIT_1170X2532: { widthCssPx: 390, heightCssPx: 844, deviceScaleFactor: 3 },
} as const;

export type ViewportPresetKey = keyof typeof VIEWPORT_PRESETS;
export const ViewportPresetKeySchema = z.enum(
  Object.keys(VIEWPORT_PRESETS) as [ViewportPresetKey, ...ViewportPresetKey[]],
);

export interface ViewportPreset {
  readonly widthCssPx: number;
  readonly heightCssPx: number;
  readonly deviceScaleFactor: number;
}

export function viewportFor(key: ViewportPresetKey): ViewportPreset {
  return VIEWPORT_PRESETS[key];
}

/** Pixel geometry a preset produces, which is what ingestion measures against. */
export function expectedPixelsFor(key: ViewportPresetKey): {
  readonly widthPx: number;
  readonly heightPx: number;
} {
  const preset = VIEWPORT_PRESETS[key];
  return {
    widthPx: preset.widthCssPx * preset.deviceScaleFactor,
    heightPx: preset.heightCssPx * preset.deviceScaleFactor,
  };
}

/**
 * The only two things a capture may do to a page besides look at it.
 *
 * `SCROLL_TO` moves a region into view. `FOLLOW_LINK` clicks an anchor — and
 * only an anchor, verified at runtime to be an `<a href>` resolving
 * same-origin to `expectPathPrefix`. There is no step that submits, votes,
 * follows, predicts, comments or buys, because there is no step kind that
 * could express one.
 */
export const NAVIGATION_STEP_KINDS = ['SCROLL_TO', 'FOLLOW_LINK'] as const;
export const NavigationStepKindSchema = z.enum(NAVIGATION_STEP_KINDS);
export type NavigationStepKind = z.infer<typeof NavigationStepKindSchema>;

export const NavigationStepSchema = z
  .object({
    kind: NavigationStepKindSchema,
    selector: z.string().min(1).max(300),
    /** Required for FOLLOW_LINK: the same-origin path the click must land on. */
    expectPathPrefix: z.string().min(1).max(300).optional(),
  })
  .strict()
  .superRefine((step, ctx) => {
    if (step.kind === 'FOLLOW_LINK') {
      if (!step.expectPathPrefix) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'FOLLOW_LINK requires expectPathPrefix — a click whose destination was not stated in advance cannot be verified as safe navigation',
          path: ['expectPathPrefix'],
        });
        return;
      }
      if (!step.expectPathPrefix.startsWith('/')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'expectPathPrefix must be a same-origin absolute path beginning with "/"',
          path: ['expectPathPrefix'],
        });
      }
    }
  });
export type NavigationStep = z.infer<typeof NavigationStepSchema>;

const SelectorSchema = z.string().min(1).max(300);

export const AppCaptureScreenSchema = z
  .object({
    /** Stable across runs. Becomes the production-asset id and the filename stem. */
    assetId: z
      .string()
      .min(1)
      .max(80)
      .regex(
        /^[a-z0-9][a-z0-9-]*$/,
        'assetId must be lowercase kebab-case so it is safe as both a manifest id and a filename',
      ),
    /** A same-origin path ("/events") or a fully-qualified same-origin URL. */
    path: z.string().min(1).max(2000),
    role: AppCaptureRoleSchema,
    viewport: ViewportPresetKeySchema,
    description: z.string().min(1).max(300),
    /** Must be present before anything is measured, redacted or photographed. */
    readinessSelector: SelectorSchema,
    /** Optional: photograph this element's box instead of the viewport. */
    cropSelector: SelectorSchema.optional(),
    /** Redacted when present. A miss is recorded, not fatal. */
    redactionSelectors: z.array(SelectorSchema).max(50).default([]),
    /** Redacted when present. A miss fails a required screen. */
    requiredRedactionSelectors: z.array(SelectorSchema).max(50).default([]),
    navigation: z.array(NavigationStepSchema).max(4).default([]),
    timeoutMs: z.number().int().min(1_000).max(120_000).default(45_000),
    /**
     * Quiet time after readiness, before redaction and the shutter. Fixed, not
     * sampled: two runs must agree, and "wait until it looks done" does not.
     */
    settleMs: z.number().int().min(0).max(15_000).default(1_500),
    /** A required screen that fails fails the session. */
    required: z.boolean().default(true),
    /** Omitted means `isEnabledByDefault(role)`. See ROLES_DISABLED_BY_DEFAULT. */
    enabled: z.boolean().optional(),
  })
  .strict()
  .superRefine((screen, ctx) => {
    if (
      screen.role === 'APP_DISCUSSION_SANITISED' &&
      screen.enabled === true &&
      screen.requiredRedactionSelectors.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'an enabled APP_DISCUSSION_SANITISED screen must declare at least one requiredRedactionSelector — "sanitised" is a claim about identifiers having been removed, and an unenforced claim is not one',
        path: ['requiredRedactionSelectors'],
      });
    }
  });
export type AppCaptureScreen = z.infer<typeof AppCaptureScreenSchema>;

/** Whether this screen runs, after the role default is applied. */
export function screenIsEnabled(screen: AppCaptureScreen): boolean {
  return screen.enabled ?? isEnabledByDefault(screen.role);
}

const HostnameSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/,
    'host must be a bare lowercase hostname with no scheme, port, path or credentials',
  );

export const AppCaptureSpecificationSchema = z
  .object({
    specificationVersion: z.literal(APP_CAPTURE_CONTRACT_VERSION),
    name: z.string().min(1).max(120),
    /**
     * Where the screens live. Configurable on purpose: no host belongs in
     * adapter logic, and the fixture site and the live site differ only here.
     */
    baseUrl: z.string().url(),
    /** Every host the browser may talk to at all. The base URL's host must be one. */
    allowedHosts: z.array(HostnameSchema).min(1).max(20),
    library: z.string().min(1).max(200),
    /**
     * When set, a rights declaration must carry this exact version. A library
     * re-approved under new terms gets a new number, so an old declaration
     * cannot silently keep authorising new captures.
     */
    expectedRightsDeclarationVersion: z.number().int().positive().optional(),
    screens: z.array(AppCaptureScreenSchema).min(1).max(40),
  })
  .strict()
  .superRefine((spec, ctx) => {
    let baseHost: string;
    try {
      const parsed = new URL(spec.baseUrl);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `baseUrl must be http or https, not ${parsed.protocol}`,
          path: ['baseUrl'],
        });
        return;
      }
      if (parsed.username || parsed.password) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'baseUrl must not carry credentials',
          path: ['baseUrl'],
        });
        return;
      }
      baseHost = parsed.hostname.toLowerCase();
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'baseUrl is not a URL',
        path: ['baseUrl'],
      });
      return;
    }

    if (!spec.allowedHosts.includes(baseHost)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `baseUrl host "${baseHost}" is not in allowedHosts — the allowlist is the only thing the browser is permitted to contact, so it must contain the site being captured`,
        path: ['allowedHosts'],
      });
    }

    const seen = new Set<string>();
    spec.screens.forEach((screen, index) => {
      if (seen.has(screen.assetId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate assetId "${screen.assetId}"`,
          path: ['screens', index, 'assetId'],
        });
      }
      seen.add(screen.assetId);

      // A screen path is resolved against baseUrl at capture time; an absolute
      // one that points elsewhere is a cross-origin capture wearing a path's
      // clothing, and is refused here rather than at navigation.
      if (/^[a-z][a-z0-9+.-]*:/i.test(screen.path)) {
        try {
          const resolved = new URL(screen.path);
          if (resolved.hostname.toLowerCase() !== baseHost) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `screen path "${screen.path}" resolves to ${resolved.hostname}, which is not the base host ${baseHost}`,
              path: ['screens', index, 'path'],
            });
          }
        } catch {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `screen path "${screen.path}" looks absolute but is not a URL`,
            path: ['screens', index, 'path'],
          });
        }
      } else if (!screen.path.startsWith('/')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `screen path "${screen.path}" must be a same-origin absolute path beginning with "/" or a fully-qualified same-origin URL`,
          path: ['screens', index, 'path'],
        });
      }
    });

    if (!spec.screens.some((screen) => screenIsEnabled(screen))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'every screen is disabled, so this specification would capture nothing. APP_DISCUSSION_SANITISED screens are disabled unless enabled: true is stated explicitly.',
        path: ['screens'],
      });
    }
  });
export type AppCaptureSpecification = z.infer<typeof AppCaptureSpecificationSchema>;

/**
 * The human's statement that this UI may appear in an advertisement.
 *
 * Every field is something a person has to know and be willing to put their
 * name to. There is no default, no inferred value and no "assume yes" path:
 * the absence of this document is a complete answer, and the answer is no.
 */
export const UI_OWNERSHIP_BASES = ['OWNED_UI_CAPTURE', 'LICENSED_UI_CAPTURE'] as const;
export const UiOwnershipBasisSchema = z.enum(UI_OWNERSHIP_BASES);
export type UiOwnershipBasis = z.infer<typeof UiOwnershipBasisSchema>;

export const THIRD_PARTY_IMAGERY_HANDLINGS = [
  'NONE_PRESENT',
  'LICENSED_FOR_OUTPUT',
  'REMOVED_OR_MASKED',
] as const;
export const ThirdPartyImageryHandlingSchema = z.enum(THIRD_PARTY_IMAGERY_HANDLINGS);
export type ThirdPartyImageryHandling = z.infer<typeof ThirdPartyImageryHandlingSchema>;

const IsoInstantSchema = z
  .string()
  .datetime({ offset: true })
  .or(z.string().datetime())
  .describe('ISO-8601 instant');

export const AppCaptureRightsDeclarationSchema = z
  .object({
    declarationVersion: z.number().int().positive(),
    /** The company or team asserting the rights. */
    declaringEntity: z.string().min(1).max(200),
    /** The named person who made the assertion. Attribution is the point. */
    declaredBy: z.string().min(1).max(200),
    declaredAt: IsoInstantSchema,
    /** Must equal the host actually captured. A declaration for one site cannot licence another. */
    approvedHost: HostnameSchema,
    basis: UiOwnershipBasisSchema,
    /**
     * Literal true, not boolean. A declaration that says `false` is not a
     * weaker declaration — it is an absent one, and it is refused at parse.
     */
    uiOwnershipConfirmed: z.literal(true),
    thirdPartyImagery: ThirdPartyImageryHandlingSchema,
    thirdPartyImageryConfirmed: z.literal(true),
    approvedOutputChannels: z.array(z.string().min(1).max(80)).min(1).max(20),
    territory: z.string().min(1).max(120),
    /** Absent means perpetual. Present and past refuses every asset. */
    expiresAt: IsoInstantSchema.optional(),
    /** Where the signed approval lives — a ticket, a contract reference, a file. */
    evidenceReference: z.string().min(1).max(300),
    notes: z.string().max(1000).optional(),
  })
  .strict();
export type AppCaptureRightsDeclaration = z.infer<typeof AppCaptureRightsDeclarationSchema>;

/**
 * How a captured asset may be used.
 *
 * `REVIEW_REQUIRED` is not a lesser grade of eligible — it is the state of
 * every capture taken without a declaration, and the merge into a production
 * manifest refuses it by name.
 */
export const CAPTURE_ELIGIBILITY = ['OUTPUT_ELIGIBLE', 'REVIEW_REQUIRED'] as const;
export const CaptureEligibilitySchema = z.enum(CAPTURE_ELIGIBILITY);
export type CaptureEligibility = z.infer<typeof CaptureEligibilitySchema>;

export const CaptureRedactionSelectorResultSchema = z
  .object({
    selector: z.string(),
    required: z.boolean(),
    matched: z.number().int().min(0),
    /** Never the text that was redacted — only that it was, and how much of it. */
    satisfied: z.boolean(),
  })
  .strict();
export type CaptureRedactionSelectorResult = z.infer<typeof CaptureRedactionSelectorResultSchema>;

export const CaptureRedactionReportSchema = z
  .object({
    assetId: z.string(),
    role: AppCaptureRoleSchema,
    /** Applied because the role is not APP_DISCUSSION_SANITISED. */
    userContentRedactionApplied: z.boolean(),
    accountRedactionApplied: z.boolean(),
    selectors: z.array(CaptureRedactionSelectorResultSchema),
    totalElementsRedacted: z.number().int().min(0),
    unsatisfiedRequiredSelectors: z.array(z.string()),
  })
  .strict();
export type CaptureRedactionReport = z.infer<typeof CaptureRedactionReportSchema>;

export const BlockedRequestRecordSchema = z
  .object({
    method: z.string(),
    /** Path only. Query strings are never recorded — they carry tokens. */
    path: z.string(),
    host: z.string(),
    reason: z.enum(['NON_READ_METHOD', 'HOST_NOT_ALLOWED', 'DOWNLOAD', 'POPUP']),
    count: z.number().int().min(1),
  })
  .strict();
export type BlockedRequestRecord = z.infer<typeof BlockedRequestRecordSchema>;

export const CapturedAppAssetSchema = z
  .object({
    assetId: z.string(),
    role: AppCaptureRoleSchema,
    eligibility: CaptureEligibilitySchema,
    /** The existing production vocabulary, or null when REVIEW_REQUIRED. */
    rightsClassification: z.enum(['OWNED', 'LICENSED_FOR_OUTPUT']).nullable(),
    rightsBasis: UiOwnershipBasisSchema.nullable(),
    /** Relative to the capture output directory, forward-slashed. */
    relativePath: z.string(),
    checksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
    widthPx: z.number().int().positive(),
    heightPx: z.number().int().positive(),
    format: z.string(),
    sizeBytes: z.number().int().positive(),
    provenance: z
      .object({
        sourceHost: z.string(),
        /** Pathname only, never the query. */
        sourcePath: z.string(),
        queryPresent: z.boolean(),
        capturedAt: IsoInstantSchema,
        viewport: ViewportPresetKeySchema,
        viewportWidthCssPx: z.number().int().positive(),
        viewportHeightCssPx: z.number().int().positive(),
        deviceScaleFactor: z.number().positive(),
        specificationVersion: z.number().int().positive(),
        specificationName: z.string(),
        rightsDeclarationVersion: z.number().int().positive().nullable(),
        browserEngine: z.string(),
        browserVersion: z.string(),
        playwrightVersion: z.string(),
        redactedElementCount: z.number().int().min(0),
        croppedToSelector: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type CapturedAppAsset = z.infer<typeof CapturedAppAssetSchema>;

export const CAPTURE_FAILURE_KINDS = [
  'INVALID_SPECIFICATION',
  'DISALLOWED_HOST',
  'MUTATION_ATTEMPTED',
  'NAVIGATION_FAILURE',
  'READINESS_FAILURE',
  'REDACTION_FAILURE',
  'SCREENSHOT_FAILURE',
  'RIGHTS_FAILURE',
  'INGESTION_FAILURE',
] as const;
export const CaptureFailureKindSchema = z.enum(CAPTURE_FAILURE_KINDS);
export type CaptureFailureKind = z.infer<typeof CaptureFailureKindSchema>;

export const CaptureFailureSchema = z
  .object({
    kind: CaptureFailureKindSchema,
    /** Which screen, or `<session>` for a failure before any screen ran. */
    assetId: z.string(),
    detail: z.string(),
  })
  .strict();
export type CaptureFailure = z.infer<typeof CaptureFailureSchema>;

export const CAPTURE_EXIT_CODES: Readonly<Record<CaptureFailureKind | 'SUCCESS', number>> = {
  SUCCESS: 0,
  INVALID_SPECIFICATION: 2,
  DISALLOWED_HOST: 3,
  MUTATION_ATTEMPTED: 4,
  NAVIGATION_FAILURE: 5,
  READINESS_FAILURE: 6,
  REDACTION_FAILURE: 7,
  SCREENSHOT_FAILURE: 8,
  RIGHTS_FAILURE: 9,
  INGESTION_FAILURE: 10,
};

export const CAPTURE_RIGHTS_NOTICE =
  'Reaching a page over HTTP establishes that it is public and nothing else. These assets are output-eligible only because a named person filed a rights declaration for this host, and only within its channels, territory and term.' as const;

export const CAPTURE_REVIEW_NOTICE =
  'NOT OUTPUT ELIGIBLE — RIGHTS REVIEW REQUIRED. This capture ran without a rights declaration. The images are for inspection only; they are refused entry to a production asset manifest and cannot reach a render.' as const;

export const AppCaptureSessionSchema = z
  .object({
    sessionVersion: z.literal(APP_CAPTURE_CONTRACT_VERSION),
    specificationName: z.string(),
    specificationVersion: z.number().int().positive(),
    /** Host only — never the full base URL with its query or credentials. */
    host: z.string(),
    startedAt: IsoInstantSchema,
    completedAt: IsoInstantSchema,
    rightsMode: z.enum(['DECLARED', 'INSPECTION_ONLY']),
    rightsDeclarationVersion: z.number().int().positive().nullable(),
    rightsDeclaredBy: z.string().nullable(),
    rightsExpiresAt: IsoInstantSchema.nullable(),
    screensRequested: z.number().int().min(0),
    screensEnabled: z.number().int().min(0),
    screensCaptured: z.number().int().min(0),
    screensSkippedDisabled: z.array(z.string()),
    assets: z.array(CapturedAppAssetSchema),
    failures: z.array(CaptureFailureSchema),
    blockedRequests: z.array(BlockedRequestRecordSchema),
    totalElementsRedacted: z.number().int().min(0),
    browserEngine: z.string(),
    browserVersion: z.string(),
    playwrightVersion: z.string(),
    /** Always false, always written. A capture is not an approval. */
    requiresHumanApproval: z.literal(true),
    paidProviderCalls: z.literal(0),
    notice: z.string(),
  })
  .strict();
export type AppCaptureSession = z.infer<typeof AppCaptureSessionSchema>;

export class AppCaptureSpecificationError extends Error {
  constructor(
    public readonly issues: readonly { readonly path: string; readonly message: string }[],
    public readonly specificationPath?: string,
  ) {
    super(
      `The capture specification${specificationPath ? ` at ${specificationPath}` : ''} is invalid:\n${issues
        .map((issue) => `  - ${issue.path || '<root>'}: ${issue.message}`)
        .join('\n')}`,
    );
    this.name = 'AppCaptureSpecificationError';
  }
}

export class AppCaptureRightsError extends Error {
  constructor(public readonly reasons: readonly string[]) {
    super(`The rights declaration cannot authorise this capture:\n  - ${reasons.join('\n  - ')}`);
    this.name = 'AppCaptureRightsError';
  }
}

function issuesFrom(error: z.ZodError): readonly { path: string; message: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

export function parseCaptureSpecification(
  value: unknown,
  specificationPath?: string,
): AppCaptureSpecification {
  const result = AppCaptureSpecificationSchema.safeParse(value);
  if (!result.success) {
    throw new AppCaptureSpecificationError(issuesFrom(result.error), specificationPath);
  }
  return result.data;
}

export function parseRightsDeclaration(
  value: unknown,
  declarationPath?: string,
): AppCaptureRightsDeclaration {
  const result = AppCaptureRightsDeclarationSchema.safeParse(value);
  if (!result.success) {
    throw new AppCaptureSpecificationError(issuesFrom(result.error), declarationPath);
  }
  return result.data;
}
