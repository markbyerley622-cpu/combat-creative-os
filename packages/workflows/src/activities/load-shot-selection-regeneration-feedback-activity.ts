import type { ScriptDataSource, ShotSelectionDataSource } from '@combat/database';
import {
  getLatestScript,
  getLatestShotSelectionSet,
  getLatestShotSpecification,
  listShotSelections,
  listShotsForScript,
} from '@combat/database';
import type { ShotDataSource, ShotSpecificationDataSource } from '@combat/database';

export interface LoadShotSelectionRegenerationFeedbackInput {
  readonly workspaceId: string;
  readonly campaignId: string;
}

export interface ShotRegenerationFeedback {
  readonly shotSpecificationId: string;
  readonly feedback: string;
}

export type LoadShotSelectionRegenerationFeedbackOutput = {
  readonly feedback: readonly ShotRegenerationFeedback[];
};

export interface LoadShotSelectionRegenerationFeedbackActivityDeps {
  readonly shotSelectionDb: ShotSelectionDataSource;
  readonly scriptDb: ScriptDataSource & ShotDataSource;
  readonly shotSpecificationDb: ShotSpecificationDataSource;
}

/**
 * M8: on a HUMAN_SHOT_SELECTION -> SHOT_GENERATION regeneration re-entry, reads
 * the per-shot regeneration feedback the reviewer attached to the latest
 * `ShotSelectionSet`'s REJECTED shots and maps each to its latest
 * `ShotSpecification` id. The workflow supplies this to the generation stage
 * as provenance for what the reviewer asked to be fixed.
 *
 * Interim narrowing (M8): the deterministic mock provider does not consume
 * this feedback and the M6 child regenerates *every* shot, so targeted
 * (rejected-shots-only) regeneration is not yet implemented — the feedback is
 * persisted and surfaced here, ready for a real provider/prompt path to act on
 * (documented in docs/architecture.md §8's M8 entry).
 */
export function createLoadShotSelectionRegenerationFeedbackActivity(
  deps: LoadShotSelectionRegenerationFeedbackActivityDeps,
): (
  input: LoadShotSelectionRegenerationFeedbackInput,
) => Promise<LoadShotSelectionRegenerationFeedbackOutput> {
  return async function loadShotSelectionRegenerationFeedbackActivity(
    input: LoadShotSelectionRegenerationFeedbackInput,
  ): Promise<LoadShotSelectionRegenerationFeedbackOutput> {
    const { workspaceId, campaignId } = input;
    const set = await getLatestShotSelectionSet(deps.shotSelectionDb, workspaceId, campaignId);
    if (!set) return { feedback: [] };

    const selections = await listShotSelections(deps.shotSelectionDb, set.id);
    const rejected = selections.filter((s) => s.status === 'REJECTED' && s.regenerationFeedback);
    if (rejected.length === 0) return { feedback: [] };

    // Map each rejected shot to its latest ShotSpecification id (the id the
    // generation stage keys on). Resolve through the script's shots so a
    // superseded selection still points at the current spec.
    const script = await getLatestScript(deps.scriptDb, workspaceId, campaignId);
    if (!script) return { feedback: [] };
    const shots = await listShotsForScript(deps.scriptDb, script.id);
    const shotIds = new Set(shots.map((s) => s.id));

    const feedback: ShotRegenerationFeedback[] = [];
    for (const selection of rejected) {
      if (!shotIds.has(selection.shotId)) continue;
      // eslint-disable-next-line no-await-in-loop -- small, per-set set
      const spec = await getLatestShotSpecification(
        deps.shotSpecificationDb,
        workspaceId,
        selection.shotId,
      );
      if (spec) {
        feedback.push({ shotSpecificationId: spec.id, feedback: selection.regenerationFeedback! });
      }
    }
    return { feedback };
  };
}
