'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import { useSession } from '@/lib/session';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Gates every page behind the dev-only identity picker (see lib/session.tsx)
 * so screens never render without a `workspaceId`/`userId` to call
 * apps/api with.
 */
export function SessionGate({ children }: { children: ReactNode }) {
  const { session, setSession } = useSession();
  const [workspaceId, setWorkspaceId] = useState('');
  const [userId, setUserId] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (session) {
    return <>{children}</>;
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!UUID_PATTERN.test(workspaceId) || !UUID_PATTERN.test(userId)) {
      setError('Enter valid UUIDs for both workspace and user.');
      return;
    }
    setError(null);
    setSession({ workspaceId, userId });
  }

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '3rem', maxWidth: 480 }}>
      <h1>Combat Creative OS</h1>
      <p style={{ color: '#666' }}>
        Development identity — there is no session/auth layer yet, so this browser needs a workspace
        and membership user id to call the API as. Not production authentication.
      </p>
      <form onSubmit={handleSubmit} aria-label="Development identity">
        <div style={{ marginBottom: '1rem' }}>
          <label htmlFor="workspaceId" style={{ display: 'block', marginBottom: 4 }}>
            Workspace ID
          </label>
          <input
            id="workspaceId"
            value={workspaceId}
            onChange={(e) => setWorkspaceId(e.target.value)}
            style={{ width: '100%', padding: 8 }}
            placeholder="00000000-0000-0000-0000-000000000000"
          />
        </div>
        <div style={{ marginBottom: '1rem' }}>
          <label htmlFor="userId" style={{ display: 'block', marginBottom: 4 }}>
            User ID (membership)
          </label>
          <input
            id="userId"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            style={{ width: '100%', padding: 8 }}
            placeholder="00000000-0000-0000-0000-000000000000"
          />
        </div>
        {error && (
          <p role="alert" style={{ color: '#b00020' }}>
            {error}
          </p>
        )}
        <button type="submit" style={{ padding: '8px 16px' }}>
          Continue
        </button>
      </form>
    </main>
  );
}
