'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { WorkspaceGate } from '@/components/WorkspaceGate';
import { ErrorState, PageShell } from '@/components/PageShell';
import { ApiError, createApiClient } from '@/lib/api-client';
import { useWorkspace } from '@/lib/workspace';

function CreateCampaignForm() {
  const { workspace, getToken } = useWorkspace();
  const router = useRouter();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!workspace) return;
    if (name.trim().length === 0) {
      setError('Campaign name is required.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const client = createApiClient(workspace.workspaceId, getToken);
      const { campaign } = await client.createCampaign(name.trim());
      router.push(`/campaigns/${campaign.id}/brief`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setError('Your role cannot create campaigns.');
      } else {
        setError('Could not create the campaign. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <PageShell title="Create campaign">
      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: '1rem' }}>
          <label htmlFor="name" style={{ display: 'block', marginBottom: 4 }}>
            Campaign name
          </label>
          <input
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ width: '100%', maxWidth: 400, padding: 8 }}
          />
        </div>
        {error && <ErrorState message={error} />}
        <button type="submit" disabled={submitting} style={{ padding: '8px 16px' }}>
          {submitting ? 'Creating…' : 'Create campaign'}
        </button>
      </form>
    </PageShell>
  );
}

export default function NewCampaignPage() {
  return (
    <WorkspaceGate>
      <CreateCampaignForm />
    </WorkspaceGate>
  );
}
