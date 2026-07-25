'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { SessionGate } from '@/components/SessionGate';
import { ErrorState, LoadingState, PageShell } from '@/components/PageShell';
import { createApiClient, type CampaignStatus } from '@/lib/api-client';
import { useSession } from '@/lib/session';

const POLL_INTERVAL_MS = 4000;

function ProductionProgress({ campaignId }: { campaignId: string }) {
  const { session } = useSession();
  const [status, setStatus] = useState<CampaignStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    const client = createApiClient(session.workspaceId, session.userId);
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
  }, [session, campaignId]);

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
      {status.workflow?.status === 'BLOCKED' && (
        <ErrorState message="This campaign's workflow is blocked and needs attention." />
      )}
    </div>
  );
}

export default function CampaignStatusPage({ params }: { params: { campaignId: string } }) {
  return (
    <SessionGate>
      <PageShell title="Production progress">
        <ProductionProgress campaignId={params.campaignId} />
      </PageShell>
    </SessionGate>
  );
}
