import { FinalQaControllerResultSchema } from '@combat/agents';
import type { AgentDefinition } from '@combat/agent-runtime';
import type {
  AssetDataSource,
  CampaignBriefDataSource,
  PromptDataSource,
  QualityAssessmentDataSource,
  QualityFindingInput,
  VariantDataSource,
} from '@combat/database';
import {
  approveVariantSpecificationForExport,
  createQualityAssessmentForAsset,
  getCreativeVariantForSpecification,
  getLatestAcceptedCampaignBrief,
  getOrCreatePromptVersionForAgent,
  getVariantSpecification,
  updateCreativeVariant,
} from '@combat/database';
import type { ExecuteSpecialistAgentInput, ExecuteSpecialistAgentOutput } from '@combat/domain';

export interface RunVariantFinalQaInput {
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly workflowRunId: string;
  readonly variantSpecificationId: string;
  /** 1-based; distinguishes the agent idempotency key of each QA re-run. */
  readonly revisionAttempt: number;
}

export type RunVariantFinalQaOutput =
  | {
      readonly ok: true;
      readonly pass: boolean;
      readonly assessmentId: string;
      readonly creativeVariantId: string;
      readonly overallScore: number;
      readonly blockingFindingCount: number;
    }
  | { readonly ok: false; readonly reason: 'SPEC_NOT_FOUND'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'VARIANT_NOT_RENDERED'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'BRIEF_NOT_FOUND'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'AGENT_FAILED'; readonly detail: string };

export interface RunVariantFinalQaActivityDeps {
  readonly executeSpecialistAgentActivity: (
    input: ExecuteSpecialistAgentInput,
  ) => Promise<ExecuteSpecialistAgentOutput>;
  readonly agentRegistry: Readonly<Record<string, AgentDefinition<unknown, unknown>>>;
  readonly campaignBriefDb: CampaignBriefDataSource;
  readonly variantDb: VariantDataSource;
  readonly qualityAssessmentDb: QualityAssessmentDataSource;
  readonly promptDb: PromptDataSource;
  readonly assetDb: AssetDataSource;
}

/**
 * M12: re-runs the M11 `final-qa-controller` over ONE rendered variant, and
 * persists the verdict as an immutable asset-based `QualityAssessment`
 * (`subjectStage: 'VARIANT_QA'`) over the variant's own asset — the same
 * `createQualityAssessmentForAsset` path the master's FINAL_QA uses, so the
 * variant carries the same auditable QA record shape its parent does. "Variant
 * QA reusing Final QA logic" per docs/architecture.md §8's M12 entry.
 *
 * The technical probe is derived from the **variant's own** persisted
 * specification (its exact cut duration, the profile's resolution, and whether
 * the cut actually retained captions), and judged against the delivery profile
 * the specification pinned — so a variant that drifted from its target, lost
 * its captions, or dropped a required CTA is caught here rather than shipping.
 * As in M11, loudness is nominal (no audio bytes exist to measure).
 *
 * This Activity is the ONLY thing that may promote a variant to `READY`, and it
 * freezes the specification for export on a pass — from then on the cut is
 * immutable. A failing variant is marked `FAILED`, which is exactly what the
 * `variantQAFailed` fact reads to route the campaign back to VARIANT_GENERATION.
 */
export function createRunVariantFinalQaActivity(
  deps: RunVariantFinalQaActivityDeps,
): (input: RunVariantFinalQaInput) => Promise<RunVariantFinalQaOutput> {
  return async function runVariantFinalQaActivity(
    input: RunVariantFinalQaInput,
  ): Promise<RunVariantFinalQaOutput> {
    const { workspaceId, campaignId, workflowRunId, variantSpecificationId, revisionAttempt } =
      input;

    const spec = await getVariantSpecification(deps.variantDb, workspaceId, variantSpecificationId);
    if (!spec) {
      return {
        ok: false,
        reason: 'SPEC_NOT_FOUND',
        detail: `VariantSpecification ${variantSpecificationId} not found in workspace ${workspaceId}`,
      };
    }

    const variant = await getCreativeVariantForSpecification(
      deps.variantDb,
      workspaceId,
      variantSpecificationId,
    );
    if (!variant?.assetId) {
      return {
        ok: false,
        reason: 'VARIANT_NOT_RENDERED',
        detail: `VariantSpecification ${variantSpecificationId} has no rendered variant asset to assess`,
      };
    }

    const brief = await getLatestAcceptedCampaignBrief(
      deps.campaignBriefDb,
      workspaceId,
      campaignId,
    );
    if (!brief) {
      return {
        ok: false,
        reason: 'BRIEF_NOT_FOUND',
        detail: `Campaign ${campaignId} has no accepted CampaignBrief`,
      };
    }

    const definition = deps.agentRegistry['final-qa-controller'];
    if (!definition) {
      throw new Error('"final-qa-controller" is not registered in the injected agent registry');
    }
    await getOrCreatePromptVersionForAgent(deps.promptDb, workspaceId, {
      agentKey: 'final-qa-controller',
      version: definition.promptVersion.version,
      systemPrompt: definition.promptVersion.systemPrompt,
    });

    // The probe describes the VARIANT, not the master: its real cut duration,
    // the profile's delivery format, and whether the cut retained captions.
    const technicalProbe = {
      durationSeconds: spec.targetDurationFrames / spec.frameRate,
      resolutionWidth: spec.resolutionWidth,
      resolutionHeight: spec.resolutionHeight,
      // Nominal, not measured — no audio bytes exist (same M11 limitation).
      integratedLoudnessLufs: -14,
      hasBurnedInCaptions: spec.retainedCaptions.length > 0,
    };
    const deliverySpecification = {
      platform: spec.platform,
      aspectRatio: spec.aspectRatio,
      durationSeconds: spec.targetDurationSeconds,
      captionBurnRequired: spec.captionBurnRequired,
      targetLoudnessLufs: -14,
    };

    const agentResult = await deps.executeSpecialistAgentActivity({
      workspaceId,
      campaignId,
      workflowRunId,
      // The campaign is still at VARIANT_GENERATION while the child workflow
      // runs — `executeSpecialistAgentActivity` enforces that the invocation's
      // stage matches the campaign's actual stage. This is the *invocation*
      // stage (where the work happened); the assessment's `subjectStage` below
      // is VARIANT_QA (what is being judged). The two are deliberately
      // different, exactly as `RoughEditSpecification` is written during
      // COMPOSITING but describes the ROUGH_CUT.
      stage: 'VARIANT_GENERATION',
      agentName: 'final-qa-controller',
      agentVersion: definition.promptVersion.version,
      idempotencyKey: `${workflowRunId}:AGENT:VARIANT_QA:final-qa-controller:${variant.assetId}:${revisionAttempt}`,
      // ^ keyed on VARIANT_QA (the subject) so it never collides with the
      //   master's FINAL_QA invocation or the variant-generator's.
      payload: { technicalProbe, deliverySpecification },
      context: {
        campaignId,
        priorArtifactRefs: [spec.id, spec.parentMasterAssetId, variant.assetId],
        budgetRemainingCents: brief.budgetCents,
      },
      correlationId: workflowRunId,
      budgetScope: {},
    });
    if (agentResult.status !== 'SUCCEEDED') {
      return {
        ok: false,
        reason: 'AGENT_FAILED',
        detail:
          agentResult.failure?.message ??
          `final-qa-controller invocation failed for variant ${variantSpecificationId}`,
      };
    }

    const result = FinalQaControllerResultSchema.parse(agentResult.result);
    const pass = result.criterionScores.every((c) => c.pass);
    const scores = Object.fromEntries(result.criterionScores.map((c) => [c.criterionId, c.score]));
    const overallScore =
      result.criterionScores.reduce((sum, c) => sum + c.score, 0) / result.criterionScores.length;
    const failures: QualityFindingInput[] = result.findings.map((f) => ({
      category: f.category,
      severity: f.severity,
      description: f.description,
      suggestedAction: f.suggestedAction,
    }));

    const { assessment } = await createQualityAssessmentForAsset(
      deps.qualityAssessmentDb,
      workspaceId,
      {
        campaignId,
        assetId: variant.assetId,
        subjectStage: 'VARIANT_QA',
        pass,
        overallScore,
        scores,
        assessedBy: 'AGENT',
        createdByAgentInvocationId: agentResult.invocationId,
        failures,
      },
    );

    await updateCreativeVariant(deps.variantDb, variant.id, {
      status: pass ? 'READY' : 'FAILED',
      qualityAssessmentId: assessment.id,
    });
    if (pass) {
      // Freeze the cut: from here the specification is immutable.
      await approveVariantSpecificationForExport(deps.variantDb, workspaceId, spec.id);
    }

    return {
      ok: true,
      pass,
      assessmentId: assessment.id,
      creativeVariantId: variant.id,
      overallScore,
      blockingFindingCount: failures.filter((f) => f.severity === 'BLOCKING').length,
    };
  };
}
