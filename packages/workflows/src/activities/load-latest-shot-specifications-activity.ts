import type {
  ScriptDataSource,
  ShotDataSource,
  ShotSpecificationDataSource,
} from '@combat/database';
import { getLatestScript, getLatestShotSpecification, listShotsForScript } from '@combat/database';

export interface LoadLatestShotSpecificationsInput {
  readonly workspaceId: string;
  readonly campaignId: string;
}

export type LoadLatestShotSpecificationsOutput =
  | { readonly ok: true; readonly shotSpecificationIds: string[] }
  | { readonly ok: false; readonly reason: 'SCRIPT_NOT_FOUND'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'SHOT_MISSING_SPECIFICATION'; readonly detail: string };

export interface LoadLatestShotSpecificationsActivityDeps {
  readonly scriptDb: ScriptDataSource & ShotDataSource;
  readonly shotSpecificationDb: ShotSpecificationDataSource;
}

/**
 * Resolves the `ShotSpecification` ids `ShotGenerationWorkflow` should
 * generate against for the campaign's *current* SHOT_GENERATION visit —
 * whether that's the first visit (reached from PROMPTING) or a revision
 * revisit (VISUAL_QA/CONTINUITY_QA/HUMAN_SHOT_SELECTION -> SHOT_GENERATION,
 * docs/domain-model.md's revision-loop edges), both of which land on
 * SHOT_GENERATION directly rather than re-running the Shot Prompt Engineer.
 * A DB-driven lookup (not a workflow-held variable carried over from the
 * PROMPTING visit) so every SHOT_GENERATION entry is self-sufficient and
 * correctly reuses the latest-persisted specification for each shot
 * regardless of how this stage was reached.
 */
export function createLoadLatestShotSpecificationsActivity(
  deps: LoadLatestShotSpecificationsActivityDeps,
): (input: LoadLatestShotSpecificationsInput) => Promise<LoadLatestShotSpecificationsOutput> {
  return async function loadLatestShotSpecificationsActivity(
    input: LoadLatestShotSpecificationsInput,
  ): Promise<LoadLatestShotSpecificationsOutput> {
    const { workspaceId, campaignId } = input;

    const script = await getLatestScript(deps.scriptDb, workspaceId, campaignId);
    if (!script) {
      return {
        ok: false,
        reason: 'SCRIPT_NOT_FOUND',
        detail: `Campaign ${campaignId} has no Script`,
      };
    }

    const shots = await listShotsForScript(deps.scriptDb, script.id);
    const shotSpecificationIds: string[] = [];
    for (const shot of shots) {
      // eslint-disable-next-line no-await-in-loop -- small, campaign-scoped set; order must be deterministic for the resulting id list
      const spec = await getLatestShotSpecification(deps.shotSpecificationDb, workspaceId, shot.id);
      if (!spec) {
        return {
          ok: false,
          reason: 'SHOT_MISSING_SPECIFICATION',
          detail: `Shot ${shot.id} has no ShotSpecification`,
        };
      }
      shotSpecificationIds.push(spec.id);
    }

    return { ok: true, shotSpecificationIds };
  };
}
