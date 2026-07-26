'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { WorkspaceGate } from '@/components/WorkspaceGate';
import { ErrorState, LoadingState, PageShell } from '@/components/PageShell';
import { createApiClient, type CampaignStatus } from '@/lib/api-client';
import { useWorkspace } from '@/lib/workspace';

const POLL_INTERVAL_MS = 4000;

function ProductionProgress({ campaignId }: { campaignId: string }) {
  const { workspace, getToken } = useWorkspace();
  const [status, setStatus] = useState<CampaignStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspace) return;
    const client = createApiClient(workspace.workspaceId, getToken);
    let cancelled = false;

    async function poll() {
      try {
        const result = await client.getCampaignStatus(campaignId);
        if (!cancelled) {
          setStatus(result);
          setError(null);
        }
      } catch {
        if (!cancelled) setError('Could not load campaign status.');
      }
    }

    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [workspace, getToken, campaignId]);

  if (error) return <ErrorState message={error} />;
  if (!status) return <LoadingState label="Loading campaign status…" />;

  const isAwaitingConcept = status.workflow?.pendingGate === 'CONCEPT';
  const SHOT_GENERATION_STAGES = [
    'PROMPTING',
    'SHOT_GENERATION',
    'VISUAL_QA',
    'CONTINUITY_QA',
    'HUMAN_SHOT_SELECTION',
  ];
  const showsShotGeneration = SHOT_GENERATION_STAGES.includes(status.currentStage);
  const showsShotSelection = status.currentStage === 'HUMAN_SHOT_SELECTION';
  const showsCompositing = status.currentStage === 'COMPOSITING';
  const showsSoundDesign = status.currentStage === 'SOUND_DESIGN';
  // M11: the Final QA verdict and the FINAL gate live on one screen — visible
  // from FINAL_QA (verdict only) through FINAL_APPROVAL (verdict + gate).
  // M12: delivery variants are visible from VARIANT_GENERATION through VARIANT_QA.
  const showsVariants =
    status.currentStage === 'VARIANT_GENERATION' || status.currentStage === 'VARIANT_QA';
  const showsFinalApproval =
    status.currentStage === 'FINAL_QA' || status.currentStage === 'FINAL_APPROVAL';

  return (
    <div>
      <p>
        Stage: <strong>{status.currentStage}</strong>
      </p>
      <p>Workflow status: {status.workflow?.status ?? 'not started'}</p>
      {status.currentStage === 'DRAFT' && (
        <p>
          <Link href={`/campaigns/${campaignId}/brief`}>Continue the campaign brief →</Link>
        </p>
      )}
      {isAwaitingConcept && (
        <p>
          <Link href={`/campaigns/${campaignId}/concept-review`}>Review the concept →</Link>
        </p>
      )}
      {showsShotGeneration && (
        <p>
          <Link href={`/campaigns/${campaignId}/shot-generation`}>
            View shot generation progress →
          </Link>
        </p>
      )}
      {showsShotSelection && (
        <p>
          <Link href={`/campaigns/${campaignId}/shot-selection`}>Review &amp; select shots →</Link>
        </p>
      )}
      {showsCompositing && (
        <p>
          <Link href={`/campaigns/${campaignId}/compositing`}>View rough edit →</Link>
        </p>
      )}
      {showsSoundDesign && (
        <p>
          <Link href={`/campaigns/${campaignId}/sound-design`}>View sound design →</Link>
        </p>
      )}
      {showsFinalApproval && (
        <p>
          <Link href={`/campaigns/${campaignId}/final-approval`}>Final QA &amp; approval →</Link>
        </p>
      )}
      {showsVariants && (
        <p>
          <Link href={`/campaigns/${campaignId}/variants`}>View delivery variants →</Link>
        </p>
      )}
      {/* M13: performance history is always reachable — data can be recorded
          for a campaign at any point after it has run. */}
      <p>
        <Link href={`/campaigns/${campaignId}/performance`}>View campaign performance →</Link>
      </p>
      <p>
        <Link href="/learnings">View creative learnings →</Link>
      </p>
      {status.workflow?.status === 'BLOCKED' && (
        <ErrorState message="This campaign's workflow is blocked and needs attention." />
      )}
    </div>
  );
}

export default function CampaignStatusPage({ params }: { params: { campaignId: string } }) {
  return (
    <WorkspaceGate>
      <PageShell title="Production progress">
        <ProductionProgress campaignId={params.campaignId} />
      </PageShell>
    </WorkspaceGate>
  );
}
