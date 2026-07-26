'use client';

import { useEffect, useState } from 'react';
import { WorkspaceGate } from '@/components/WorkspaceGate';
import { EmptyState, ErrorState, LoadingState, PageShell } from '@/components/PageShell';
import {
  createApiClient,
  type CampaignPerformanceView,
  type PerformanceObservationView,
} from '@/lib/api-client';
import { useWorkspace } from '@/lib/workspace';

const POLL_INTERVAL_MS = 5000;

function pct(value: number | undefined): string {
  return value === undefined ? '—' : `${(value * 100).toFixed(2)}%`;
}

function cents(value: number | undefined): string {
  return value === undefined ? '—' : `${(value / 100).toFixed(2)}`;
}

function ObservationRow({ observation }: { observation: PerformanceObservationView }) {
  const { normalized: n } = observation;
  return (
    <tr>
      <td>{observation.platform}</td>
      <td>{observation.externalPostId}</td>
      <td>{observation.durationSeconds ? `${observation.durationSeconds}s` : '—'}</td>
      <td>
        {observation.periodStart.slice(0, 10)} → {observation.periodEnd.slice(0, 10)}
      </td>
      <td style={{ textAlign: 'right' }}>{n.impressions.toLocaleString()}</td>
      <td style={{ textAlign: 'right' }}>{pct(n.clickThroughRate)}</td>
      <td style={{ textAlign: 'right' }}>{pct(n.conversionRate)}</td>
      <td style={{ textAlign: 'right' }}>{cents(n.costPerClickCents)}</td>
      <td>
        <span
          style={{
            padding: '1px 6px',
            fontSize: 12,
            background: '#efefef',
            borderRadius: 4,
            color: '#555',
          }}
        >
          {observation.source}
        </span>
      </td>
    </tr>
  );
}

/**
 * Deterministic fixture loader. There is no ad-platform connector in M13 — the
 * only ways data enters are this fixture button and manual entry, both of which
 * post to the same RBAC-checked ingestion endpoint.
 */
const DEMO_FIXTURE = {
  source: 'FIXTURE' as const,
  fixtureRef: 'fixtures/vertical-short-form-week-30.json',
  observations: [
    {
      platform: 'INSTAGRAM_REELS' as const,
      externalPostId: 'demo-reels-15s',
      durationSeconds: 15,
      periodStart: '2026-07-18T00:00:00.000Z',
      periodEnd: '2026-07-25T00:00:00.000Z',
      raw: { impressions: 30_000, clicks: 1_500, conversions: 90, spendCents: 60_000 },
    },
    {
      platform: 'INSTAGRAM_REELS' as const,
      externalPostId: 'demo-reels-10s',
      durationSeconds: 10,
      periodStart: '2026-07-18T00:00:00.000Z',
      periodEnd: '2026-07-25T00:00:00.000Z',
      raw: { impressions: 30_000, clicks: 900, conversions: 36, spendCents: 60_000 },
    },
  ],
};

function Performance({ campaignId }: { campaignId: string }) {
  const { workspace, getToken } = useWorkspace();
  const [data, setData] = useState<CampaignPerformanceView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    if (!workspace) return;
    const client = createApiClient(workspace.workspaceId, getToken);
    try {
      setData(await client.getCampaignPerformance(campaignId));
      setError(null);
    } catch {
      setError('Could not load the performance history.');
    }
  }

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, getToken, campaignId]);

  async function loadFixture() {
    if (!workspace) return;
    setBusy(true);
    setNotice(null);
    const client = createApiClient(workspace.workspaceId, getToken);
    try {
      const result = await client.ingestPerformance(campaignId, DEMO_FIXTURE);
      setNotice(
        `Ingested ${result.ingested} observation(s); ${result.deduplicated} already present.`,
      );
      await load();
    } catch {
      setNotice('The fixture could not be ingested.');
    } finally {
      setBusy(false);
    }
  }

  if (error) return <ErrorState message={error} />;
  if (!data) return <LoadingState label="Loading performance…" />;

  const { campaign, caller, observations } = data;

  return (
    <div>
      <p>
        Stage: <strong>{campaign.currentStage}</strong>
      </p>
      <p style={{ color: '#555', fontSize: 13 }}>
        Performance data is entered from a deterministic fixture or by hand. No advertising platform
        is connected — a real connector is a later milestone.
      </p>

      <section style={{ marginBottom: '1.5rem' }}>
        <h2>Ingest</h2>
        {!caller.canIngest && (
          <p style={{ color: '#a00' }}>Your role ({caller.role}) cannot record performance data.</p>
        )}
        <button type="button" disabled={!caller.canIngest || busy} onClick={loadFixture}>
          Load demo fixture
        </button>
        {notice && <p style={{ marginTop: '0.5rem' }}>{notice}</p>}
      </section>

      <section>
        <h2>Observations ({observations.length})</h2>
        {observations.length === 0 && (
          <EmptyState>No closed-window performance data has been recorded yet.</EmptyState>
        )}
        {observations.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid #ddd' }}>
                  <th>Platform</th>
                  <th>Post</th>
                  <th>Cut</th>
                  <th>Window</th>
                  <th style={{ textAlign: 'right' }}>Impressions</th>
                  <th style={{ textAlign: 'right' }}>CTR</th>
                  <th style={{ textAlign: 'right' }}>CVR</th>
                  <th style={{ textAlign: 'right' }}>CPC</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {observations.map((o) => (
                  <ObservationRow key={o.id} observation={o} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

export default function PerformancePage({ params }: { params: { campaignId: string } }) {
  return (
    <WorkspaceGate>
      <PageShell title="Campaign performance">
        <Performance campaignId={params.campaignId} />
      </PageShell>
    </WorkspaceGate>
  );
}
