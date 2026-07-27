import {
  AppCaptureRightsError,
  CAPTURE_REVIEW_NOTICE,
  CAPTURE_RIGHTS_NOTICE,
  type AppCaptureRightsDeclaration,
  type AppCaptureSpecification,
  type CaptureEligibility,
  type UiOwnershipBasis,
} from './capture-contracts';

/**
 * Turning a human's declaration into an output-rights decision.
 *
 * The projection here is the whole point of the module, so it is worth stating
 * plainly: `OWNED_UI_CAPTURE` and `LICENSED_UI_CAPTURE` describe *how the
 * declarer came to hold the rights*. They are not new rights classifications.
 * They project onto the two existing output-permitting classes in
 * `production-assets.ts` — `OWNED` and `LICENSED_FOR_OUTPUT` — and the
 * production-asset manifest never learns that a capture was involved.
 *
 * That direction matters. Adding a capture-shaped class to the production
 * rights enum would mean every existing check had to learn about it, and the
 * one that forgot would be the hole. Projecting instead means capture inherits
 * every rights rule the renderer already enforces, unchanged.
 */

export type ProductionRightsClassification = 'OWNED' | 'LICENSED_FOR_OUTPUT';

const BASIS_TO_CLASSIFICATION: Readonly<Record<UiOwnershipBasis, ProductionRightsClassification>> =
  {
    OWNED_UI_CAPTURE: 'OWNED',
    LICENSED_UI_CAPTURE: 'LICENSED_FOR_OUTPUT',
  };

export function classificationForBasis(basis: UiOwnershipBasis): ProductionRightsClassification {
  return BASIS_TO_CLASSIFICATION[basis];
}

export interface RightsDecision {
  readonly mode: 'DECLARED' | 'INSPECTION_ONLY';
  readonly eligibility: CaptureEligibility;
  readonly classification: ProductionRightsClassification | null;
  readonly basis: UiOwnershipBasis | null;
  readonly declarationVersion: number | null;
  readonly declaredBy: string | null;
  readonly expiresAt: string | null;
  readonly notice: string;
}

export interface EvaluateRightsOptions {
  /** Absent means inspection-only. That is a complete answer, not a missing one. */
  readonly declaration?: AppCaptureRightsDeclaration | undefined;
  readonly specification: AppCaptureSpecification;
  /** The host actually being captured, taken from the resolved base URL. */
  readonly host: string;
  /** Supplied, never read from a clock inside this function, so tests are exact. */
  readonly now: Date;
}

/**
 * Decides what a capture's output rights are, or refuses to.
 *
 * Refusal throws rather than returning a degraded decision: a caller that
 * forgot to check a returned status would produce output-eligible assets from
 * an expired licence, and every field on the declaration exists precisely
 * because somebody could otherwise be wrong about it.
 */
export function evaluateRightsDeclaration(options: EvaluateRightsOptions): RightsDecision {
  const { declaration, specification, host, now } = options;

  if (!declaration) {
    return {
      mode: 'INSPECTION_ONLY',
      eligibility: 'REVIEW_REQUIRED',
      classification: null,
      basis: null,
      declarationVersion: null,
      declaredBy: null,
      expiresAt: null,
      notice: CAPTURE_REVIEW_NOTICE,
    };
  }

  const reasons: string[] = [];

  const approvedHost = declaration.approvedHost.toLowerCase();
  const capturedHost = host.toLowerCase();
  if (approvedHost !== capturedHost) {
    reasons.push(
      `the declaration approves ${approvedHost} but this capture targets ${capturedHost} — a declaration for one site cannot licence another`,
    );
  }

  if (
    specification.expectedRightsDeclarationVersion !== undefined &&
    declaration.declarationVersion !== specification.expectedRightsDeclarationVersion
  ) {
    reasons.push(
      `the specification requires rights declaration version ${specification.expectedRightsDeclarationVersion} but this declaration is version ${declaration.declarationVersion}`,
    );
  }

  const declaredAt = new Date(declaration.declaredAt);
  if (Number.isNaN(declaredAt.getTime())) {
    reasons.push('declaredAt is not a readable instant');
  } else if (declaredAt.getTime() > now.getTime()) {
    reasons.push('declaredAt is in the future');
  }

  if (declaration.expiresAt !== undefined) {
    const expires = new Date(declaration.expiresAt);
    if (Number.isNaN(expires.getTime())) {
      reasons.push('expiresAt is not a readable instant');
    } else if (expires.getTime() <= now.getTime()) {
      reasons.push(
        `the licence term ended at ${declaration.expiresAt}; an expired declaration authorises nothing`,
      );
    }
  }

  if (reasons.length > 0) throw new AppCaptureRightsError(reasons);

  return {
    mode: 'DECLARED',
    eligibility: 'OUTPUT_ELIGIBLE',
    classification: classificationForBasis(declaration.basis),
    basis: declaration.basis,
    declarationVersion: declaration.declarationVersion,
    declaredBy: declaration.declaredBy,
    expiresAt: declaration.expiresAt ?? null,
    notice: CAPTURE_RIGHTS_NOTICE,
  };
}
