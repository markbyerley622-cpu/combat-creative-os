'use client';

import { useEffect, useState } from 'react';
import { WorkspaceGate } from '@/components/WorkspaceGate';
import { EmptyState, ErrorState, LoadingState, PageShell } from '@/components/PageShell';
import { createApiClient, type LearningRecordView, type LearningsView } from '@/lib/api-client';
import { useWorkspace } from '@/lib/workspace';

const POLL_INTERVAL_MS = 5000;

function Chip({ label, tone }: { label: string; tone: 'ok' | 'warn' | 'neutral' }) {
  const background = tone === 'ok' ? '#e3f5e3' : tone === 'warn' ? '#fbe3e3' : '#efefef';
  const color = tone === 'ok' ? '#1c5c1c' : tone === 'warn' ? '#8a1f1f' : '#555';
  return (
    <span
      style={{
        padding: '1px 6px',
        fontSize: 12,
        background,
        borderRadius: 4,
        color,
        marginLeft: 8,
      }}
    >
      {label}
    </span>
  );
}

function LearningCard({
  learning,
  canReview,
  onReview,
  busy,
}: {
  learning: LearningRecordView;
  canReview: boolean;
  onReview: (id: string, decision: 'APPROVED' | 'REJECTED') => void;
  busy: boolean;
}) {
  const statusTone =
    learning.status === 'APPROVED' ? 'ok' : learning.status === 'REJECTED' ? 'warn' : 'neutral';
  const confidenceTone = learning.confidence === 'LOW' ? 'warn' : 'neutral';
  // Mirrors MIN_INJECTABLE_CONFIDENCE in @combat/domain.
  const injectable = learning.status === 'APPROVED' && learning.confidence !== 'LOW';

  return (
    <div
      style={{
        border: '1px solid #ddd',
        borderRadius: 6,
        padding: '0.75rem',
        marginBottom: '0.75rem',
      }}
    >
      <h3 style={{ marginTop: 0 }}>
        {learning.learningKey}
        <span style={{ color: '#777', fontWeight: 'normal' }}> v{learning.version}</span>
        <Chip label={learning.status} tone={statusTone} />
        <Chip label={`${learning.confidence} confidence`} tone={confidenceTone} />
        <Chip label={learning.scope} tone="neutral" />
        {learning.superseded && <Chip label="superseded" tone="neutral" />}
      </h3>

      <p>{learning.insight}</p>

      <p style={{ fontSize: 13, color: '#555' }}>
        <strong>Applies to:</strong>{' '}
        {learning.applicability.platforms.length > 0
          ? learning.applicability.platforms.join(', ')
          : 'all platforms'}
        {' · '}
        {learning.applicability.durationsSeconds.length > 0
          ? learning.applicability.durationsSeconds.map((d) => `${d}s`).join(', ')
          : 'all durations'}
        {learning.applicability.tags.length > 0
          ? ` · ${learning.applicability.tags.join(', ')}`
          : ''}
      </p>

      <details>
        <summary>
          Evidence ({learning.evidence.length} observation(s),{' '}
          {learning.totalImpressions.toLocaleString()} impressions)
        </summary>
        <ul style={{ fontSize: 13 }}>
          {learning.evidence.map((e) => (
            <li key={e.performanceObservationId}>
              {e.platform} · {e.impressions.toLocaleString()} impressions · observation{' '}
              {e.performanceObservationId}
            </li>
          ))}
        </ul>
        <p style={{ fontSize: 13, color: '#555' }}>
          Source campaign {learning.sourceCampaignId} · analyst invocation{' '}
          {learning.createdByAgentInvocationId}
        </p>
      </details>

      <p style={{ fontSize: 13, color: injectable ? '#1c5c1c' : '#777' }}>
        {injectable
          ? 'Offered as advisory context to the Strategist / Creative Director on applicable campaigns.'
          : learning.confidence === 'LOW'
            ? 'Not offered to any agent — evidence is too thin for injection.'
            : 'Not offered to any agent until approved.'}
      </p>

      {learning.status === 'PROPOSED' && (
        <div>
          <button
            type="button"
            disabled={!canReview || busy}
            onClick={() => onReview(learning.id, 'APPROVED')}
          >
            Approve
          </button>{' '}
          <button
            type="button"
            disabled={!canReview || busy}
            onClick={() => onReview(learning.id, 'REJECTED')}
          >
            Reject
          </button>
        </div>
      )}
    </div>
  );
}

function Learnings() {
  const { workspace, getToken } = useWorkspace();
  const [data, setData] = useState<LearningsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    if (!workspace) return;
    const client = createApiClient(workspace.workspaceId, getToken);
    try {
      setData(await client.getLearnings());
      setError(null);
    } catch {
      setError('Could not load the learning records.');
    }
  }

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, getToken]);

  async function review(learningId: string, decision: 'APPROVED' | 'REJECTED') {
    if (!workspace) return;
    setBusy(true);
    setNotice(null);
    const client = createApiClient(workspace.workspaceId, getToken);
    try {
      await client.reviewLearning(learningId, decision);
      setNotice(`Learning ${decision.toLowerCase()}.`);
      await load();
    } catch {
      setNotice('The review could not be submitted.');
    } finally {
      setBusy(false);
    }
  }

  if (error) return <ErrorState message={error} />;
  if (!data) return <LoadingState label="Loading learnings…" />;

  const { caller, learnings } = data;

  return (
    <div>
      <p style={{ color: '#555', fontSize: 13 }}>
        Learnings are distilled from completed performance data by the Performance Analyst. Each one
        is advisory context only — it is offered alongside an approved brief, never in place of it,
        and can never change a campaign stage, an approval or an asset.
      </p>
      {!caller.canReview && (
        <p style={{ color: '#a00' }}>
          Your role ({caller.role}) cannot approve or reject a learning.
        </p>
      )}
      {notice && <p>{notice}</p>}

      {learnings.length === 0 && <EmptyState>No learnings have been distilled yet.</EmptyState>}
      {learnings.map((learning) => (
        <LearningCard
          key={learning.id}
          learning={learning}
          canReview={caller.canReview}
          onReview={review}
          busy={busy}
        />
      ))}
    </div>
  );
}

export default function LearningsPage() {
  return (
    <WorkspaceGate>
      <PageShell title="Creative learnings">
        <Learnings />
      </PageShell>
    </WorkspaceGate>
  );
}
