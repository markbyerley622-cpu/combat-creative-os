'use client';

import type { ReactNode } from 'react';
import { useWorkspace } from '@/lib/workspace';
import { ErrorState, LoadingState, PageShell } from './PageShell';

/**
 * AAMP-1 step 2 — replaces `SessionGate`, the development identity picker.
 *
 * The old gate asked the person at the keyboard for a `workspaceId` and a
 * `userId` and treated the answer as identity. This one asks for nothing: it
 * waits for `GET /me` to resolve the *verified* caller's memberships from
 * PostgreSQL and renders the app once one exists. There is no input to forge,
 * because there is no input.
 */
export function WorkspaceGate({ children }: { children: ReactNode }) {
  const { status, workspace, error } = useWorkspace();

  if (status === 'loading') {
    return (
      <PageShell title="Combat Creative OS">
        <LoadingState label="Loading your workspace…" />
      </PageShell>
    );
  }

  if (status === 'error') {
    return (
      <PageShell title="Combat Creative OS">
        <ErrorState message={error ?? 'Could not load your account.'} />
      </PageShell>
    );
  }

  if (status === 'no-membership' || !workspace) {
    return (
      <PageShell title="Combat Creative OS">
        <p style={{ color: '#666', maxWidth: '46ch' }}>
          You are signed in, but you are not a member of any workspace yet. Ask a workspace owner to
          add you — membership and role are held in the Combat Creative OS database, not in your
          sign-in account.
        </p>
      </PageShell>
    );
  }

  return <>{children}</>;
}
