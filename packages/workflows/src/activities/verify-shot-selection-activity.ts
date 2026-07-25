import type { ScriptDataSource, ShotSelectionDataSource } from '@combat/database';
import { getLatestScript, getLatestShotSelectionSet, listShotSelections } from '@combat/database';

export interface VerifyShotSelectionInput {
  readonly workspaceId: string;
  readonly campaignId: string;
}

export type VerifyShotSelectionOutput =
  | { readonly valid: true; readonly setId: string; readonly version: number }
  | {
      readonly valid: false;
      readonly reason: 'NO_SET' | 'NOT_APPROVED' | 'INCOMPLETE' | 'STALE_SCRIPT';
      readonly detail: string;
    };

export interface VerifyShotSelectionActivityDeps {
  readonly shotSelectionDb: ShotSelectionDataSource;
  readonly scriptDb: ScriptDataSource;
}

/**
 * M8: the workflow-engine guarantee behind the SHOT_SELECTION gate. Even after
 * `verifyHumanApprovalActivity` confirms an APPROVED HumanApproval, the
 * workflow calls this before advancing to COMPOSITING — so the gate is
 * satisfied only when the *persisted* `ShotSelectionSet` is itself APPROVED,
 * complete (every required shot SELECTED), and current (built against the
 * latest script version). A stale or incomplete selection can never cross the
 * gate, and because this reads persisted state (not the signal payload), an
 * API caller cannot fabricate gate satisfaction. This Activity only reads; it
 * never approves anything itself.
 */
export function createVerifyShotSelectionActivity(
  deps: VerifyShotSelectionActivityDeps,
): (input: VerifyShotSelectionInput) => Promise<VerifyShotSelectionOutput> {
  return async function verifyShotSelectionActivity(
    input: VerifyShotSelectionInput,
  ): Promise<VerifyShotSelectionOutput> {
    const { workspaceId, campaignId } = input;

    const set = await getLatestShotSelectionSet(deps.shotSelectionDb, workspaceId, campaignId);
    if (!set) {
      return {
        valid: false,
        reason: 'NO_SET',
        detail: 'no ShotSelectionSet exists for this campaign',
      };
    }
    if (set.status !== 'APPROVED') {
      return {
        valid: false,
        reason: 'NOT_APPROVED',
        detail: `latest ShotSelectionSet (v${set.version}) is ${set.status}, not APPROVED`,
      };
    }

    const script = await getLatestScript(deps.scriptDb, workspaceId, campaignId);
    if (!script || set.scriptVersion !== script.version) {
      return {
        valid: false,
        reason: 'STALE_SCRIPT',
        detail: `set was built against script v${set.scriptVersion}, latest is v${script?.version ?? 'none'}`,
      };
    }

    const selections = await listShotSelections(deps.shotSelectionDb, set.id);
    const unresolved = selections.filter((s) => s.status !== 'SELECTED' || !s.selectedCandidateId);
    if (selections.length === 0 || unresolved.length > 0) {
      return {
        valid: false,
        reason: 'INCOMPLETE',
        detail: `${unresolved.length} of ${selections.length} required shots are not selected`,
      };
    }

    return { valid: true, setId: set.id, version: set.version };
  };
}
