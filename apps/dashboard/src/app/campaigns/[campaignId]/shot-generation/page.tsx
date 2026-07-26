'use client';

import { useEffect, useState } from 'react';
import { WorkspaceGate } from '@/components/WorkspaceGate';
import { EmptyState, ErrorState, LoadingState, PageShell } from '@/components/PageShell';
import {
  createApiClient,
  type BudgetStatusView,
  type GenerationCandidateView,
  type ShotGenerationShotView,
  type ShotGenerationView,
} from '@/lib/api-client';
import { useWorkspace } from '@/lib/workspace';

const POLL_INTERVAL_MS = 4000;

function BudgetRow({ label, status }: { label: string; status: BudgetStatusView | null }) {
  if (!status) {
    return <p style={{ color: '#666' }}>{label}: no budget policy configured (uncapped).</p>;
  }
  return (
    <p>
      {label}: {(status.spentCents / 100).toFixed(2)} / {(status.limitCents / 100).toFixed(2)} spent
      ({(status.remainingCents / 100).toFixed(2)} remaining)
    </p>
  );
}

/** Never a `<video>` — mock candidates carry no real media (`hasMedia` is always `false`, see apps/api's doc comment). A deterministic placeholder card is the only honest rendering. */
function CandidateCard({ candidate }: { candidate: GenerationCandidateView }) {
  return (
    <div
      style={{
        border: '1px dashed #999',
        borderRadius: 4,
        padding: '0.75rem',
        marginRight: '0.5rem',
        marginBottom: '0.5rem',
        display: 'inline-block',
        minWidth: 160,
      }}
    >
      <p style={{ margin: 0, fontWeight: 600 }}>Candidate {candidate.candidateIndex}</p>
      <p style={{ margin: 0, color: '#666', fontSize: '0.85rem' }}>Status: {candidate.status}</p>
      {candidate.aspectRatio && (
        <p style={{ margin: 0, color: '#666', fontSize: '0.85rem' }}>
          {candidate.durationSeconds}s · {candidate.aspectRatio}
        </p>
      )}
      <p style={{ margin: '0.5rem 0 0', color: '#999', fontSize: '0.8rem', fontStyle: 'italic' }}>
        No preview available (mock provider — no real media generated)
      </p>
    </div>
  );
}

function ShotCard({ shot }: { shot: ShotGenerationShotView }) {
  const { specification, generationJob, attempts, candidates } = shot;
  return (
    <div
      style={{ border: '1px solid #ddd', borderRadius: 6, padding: '1rem', marginBottom: '1rem' }}
    >
      <h3 style={{ marginTop: 0 }}>
        Shot {shot.index} — {shot.beat}
      </h3>
      <p style={{ color: '#666' }}>{shot.description}</p>

      {!specification && <EmptyState>No shot specification generated yet.</EmptyState>}
      {specification && (
        <div style={{ marginBottom: '0.75rem' }}>
          <p>
            <strong>Prompt (v{specification.version}):</strong> {specification.generationPrompt}
          </p>
          <p style={{ color: '#666', fontSize: '0.9rem' }}>
            {specification.cameraMovement} · {specification.lensFraming} · {specification.lighting}{' '}
            · {specification.motionIntensity} motion
          </p>
          {specification.qualityRubric.length > 0 && (
            <p style={{ color: '#666', fontSize: '0.9rem' }}>
              QC checklist: {specification.qualityRubric.join('; ')}
            </p>
          )}
        </div>
      )}

      {generationJob && (
        <p>
          Generation status: <strong>{generationJob.status}</strong> (attempt{' '}
          {generationJob.attemptCount} of {generationJob.maxAttempts})
        </p>
      )}

      {attempts.length > 0 && (
        <div style={{ marginBottom: '0.75rem' }}>
          <p style={{ marginBottom: 4 }}>
            <strong>Attempt history</strong>
          </p>
          <ul style={{ marginTop: 0 }}>
            {attempts.map((attempt) => (
              <li key={attempt.id} style={{ fontSize: '0.9rem' }}>
                #{attempt.attemptNumber}: {attempt.status}
                {attempt.failureReason
                  ? ` — ${attempt.failureReason}: ${attempt.failureMessage}`
                  : ''}
                {attempt.actualCostCents !== undefined
                  ? ` (${(attempt.actualCostCents / 100).toFixed(2)} spent)`
                  : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      {candidates.length > 0 && (
        <div>
          {candidates.map((candidate) => (
            <CandidateCard key={candidate.id} candidate={candidate} />
          ))}
        </div>
      )}
    </div>
  );
}

function ShotGeneration({ campaignId }: { campaignId: string }) {
  const { workspace, getToken } = useWorkspace();
  const [data, setData] = useState<ShotGenerationView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspace) return;
    const client = createApiClient(workspace.workspaceId, getToken);
    let cancelled = false;

    async function poll() {
      try {
        const result = await client.getShotGeneration(campaignId);
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      } catch {
        if (!cancelled) setError('Could not load shot generation progress.');
      }
    }

    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, getToken, campaignId]);

  if (error) return <ErrorState message={error} />;
  if (!data) return <LoadingState label="Loading shot generation progress…" />;

  if (!data.script) {
    return <EmptyState>No script exists for this campaign yet.</EmptyState>;
  }

  return (
    <div>
      <section style={{ marginBottom: '1.5rem' }}>
        <h2>Budget</h2>
        <BudgetRow label="Workspace" status={data.budget.workspace} />
        <BudgetRow label="Campaign" status={data.budget.campaign} />
      </section>

      <section>
        <h2>Shots</h2>
        {data.shots.length === 0 && <EmptyState>No shots in this script.</EmptyState>}
        {data.shots.map((shot) => (
          <ShotCard key={shot.shotId} shot={shot} />
        ))}
      </section>
    </div>
  );
}

export default function ShotGenerationPage({ params }: { params: { campaignId: string } }) {
  return (
    <WorkspaceGate>
      <PageShell title="Shot generation">
        <ShotGeneration campaignId={params.campaignId} />
      </PageShell>
    </WorkspaceGate>
  );
}
