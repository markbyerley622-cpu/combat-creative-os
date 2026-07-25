'use client';

import { useEffect, useState } from 'react';
import { SessionGate } from '@/components/SessionGate';
import { EmptyState, ErrorState, LoadingState, PageShell } from '@/components/PageShell';
import {
  createApiClient,
  type BudgetStatusView,
  type SoundCueView,
  type SoundDesignView,
} from '@/lib/api-client';
import { useSession } from '@/lib/session';

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

/** Mock stems carry no real audio (`hasMedia` is always false) — a deterministic placeholder is the only honest rendering. */
function CueRow({ cue }: { cue: SoundCueView }) {
  return (
    <li style={{ marginBottom: '0.5rem' }}>
      <strong>{cue.type}</strong> @ {cue.startFrame}f for {cue.durationFrames}f
      {cue.notes ? ` — ${cue.notes}` : ''}
      <span
        style={{
          marginLeft: 8,
          padding: '1px 6px',
          fontSize: 12,
          background: '#efefef',
          borderRadius: 4,
          color: '#555',
        }}
      >
        {cue.assetId ? 'stem attached (placeholder — no audio)' : 'no stem'}
      </span>
    </li>
  );
}

function SoundDesign({ campaignId }: { campaignId: string }) {
  const { session } = useSession();
  const [data, setData] = useState<SoundDesignView | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!session) return;
    const client = createApiClient(session.workspaceId, session.userId);
    try {
      setData(await client.getSoundDesign(campaignId));
      setError(null);
    } catch {
      setError('Could not load the sound-design status.');
    }
  }

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, campaignId]);

  if (error) return <ErrorState message={error} />;
  if (!data) return <LoadingState label="Loading sound design…" />;

  const { campaign, plan, timeline, cues, budget } = data;

  return (
    <div>
      <p>
        Stage: <strong>{campaign.currentStage}</strong>
        {!campaign.isSoundDesignStage && (
          <span style={{ color: '#666' }}> (not currently in sound design)</span>
        )}
      </p>

      {!plan && (
        <EmptyState>The Sound Director has not produced a sound-design plan yet.</EmptyState>
      )}

      {plan && (
        <section style={{ marginBottom: '1.5rem' }}>
          <h2>Sound design plan (v{plan.version})</h2>
          <p>
            <strong>Music brief:</strong> {plan.musicBrief}
          </p>
          <p>
            <strong>Mix notes:</strong> {plan.mixNotes}
          </p>
          {plan.brandAudioGuidelines.length > 0 && (
            <p>
              <strong>Brand audio guidelines:</strong> {plan.brandAudioGuidelines.join('; ')}
            </p>
          )}
        </section>
      )}

      {timeline && (
        <section style={{ marginBottom: '1.5rem' }}>
          <h2>Timeline (v{timeline.version})</h2>
          <p>
            {timeline.frameRate}fps · {timeline.durationFrames} frames · {timeline.entries.length}{' '}
            entries
          </p>
        </section>
      )}

      <section style={{ marginBottom: '1.5rem' }}>
        <h2>Sound cues</h2>
        {cues.length === 0 && <EmptyState>No cues yet.</EmptyState>}
        {cues.length > 0 && (
          <ol>
            {cues.map((cue) => (
              <CueRow key={cue.id} cue={cue} />
            ))}
          </ol>
        )}
      </section>

      <section>
        <h2>Budget</h2>
        <BudgetRow label="Workspace" status={budget.workspace} />
        <BudgetRow label="Campaign" status={budget.campaign} />
      </section>
    </div>
  );
}

export default function SoundDesignPage({ params }: { params: { campaignId: string } }) {
  return (
    <SessionGate>
      <PageShell title="Sound design">
        <SoundDesign campaignId={params.campaignId} />
      </PageShell>
    </SessionGate>
  );
}
