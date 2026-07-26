'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { WorkspaceGate } from '@/components/WorkspaceGate';
import { EmptyState, ErrorState, LoadingState, PageShell } from '@/components/PageShell';
import { ApiError, createApiClient, type Campaign } from '@/lib/api-client';
import { useWorkspace } from '@/lib/workspace';

function CampaignList() {
  const { workspace, getToken } = useWorkspace();
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspace) return;
    const client = createApiClient(workspace.workspaceId, getToken);
    client
      .listCampaigns()
      .then((res) => setCampaigns(res.campaigns))
      .catch((err) =>
        setError(
          err instanceof ApiError
            ? `Could not load campaigns (${err.status}).`
            : 'Could not load campaigns.',
        ),
      );
  }, [workspace, getToken]);

  return (
    <PageShell title="Campaigns">
      <p>
        <Link href="/campaigns/new">+ Create campaign</Link>
      </p>
      {error && <ErrorState message={error} />}
      {!error && campaigns === null && <LoadingState label="Loading campaigns…" />}
      {!error && campaigns !== null && campaigns.length === 0 && (
        <EmptyState>No campaigns yet — create one to get started.</EmptyState>
      )}
      {!error && campaigns !== null && campaigns.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {campaigns.map((campaign) => (
            <li
              key={campaign.id}
              style={{
                border: '1px solid #ddd',
                borderRadius: 4,
                padding: '1rem',
                marginBottom: '0.5rem',
              }}
            >
              <Link href={`/campaigns/${campaign.id}`} style={{ fontWeight: 600 }}>
                {campaign.name}
              </Link>
              <div style={{ color: '#666', fontSize: '0.85rem' }}>
                Stage: {campaign.currentStage}
              </div>
            </li>
          ))}
        </ul>
      )}
    </PageShell>
  );
}

export default function DashboardHomePage() {
  return (
    <WorkspaceGate>
      <CampaignList />
    </WorkspaceGate>
  );
}
