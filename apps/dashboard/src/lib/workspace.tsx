'use client';

import { useAuth } from '@clerk/nextjs';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { currentAuthMode, e2eFakeToken } from './auth-mode';
import { fetchMe, type Me } from './api-client';

/**
 * AAMP-1 step 2 — where the dashboard's workspace comes from.
 *
 * This replaces the development identity picker, which asked the person at the
 * keyboard to type a `workspaceId` and a `userId` and then sent both to
 * `apps/api` as if they were proof of anything. Neither is collected any more:
 *
 * - **Identity** is a Clerk session. The browser holds a token; it never holds
 *   or sends a user id.
 * - **Workspace** is read from `GET /me`, which resolves the caller's
 *   `Membership` rows in PostgreSQL. The browser cannot pick a workspace it is
 *   not a member of, because the list it chooses from is the server's answer.
 *
 * The context exposes `getToken` rather than a token value, so every request
 * takes a freshly-minted, short-lived token instead of one captured at mount.
 */

export type WorkspaceStatus = 'loading' | 'ready' | 'no-membership' | 'error';

export interface WorkspaceMembership {
  readonly workspaceId: string;
  readonly role: string;
}

export interface WorkspaceContextValue {
  readonly status: WorkspaceStatus;
  /** The active workspace, once resolved. */
  readonly workspace: WorkspaceMembership | null;
  /** Every workspace the verified caller belongs to. */
  readonly memberships: readonly WorkspaceMembership[];
  readonly userId: string | null;
  readonly email: string | null;
  readonly error: string | null;
  /** Mints a session token for an `apps/api` call. Returns null when signed out. */
  readonly getToken: () => Promise<string | null>;
  readonly selectWorkspace: (workspaceId: string) => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | undefined>(undefined);

/**
 * The token source is chosen at the *component* level, not inside a hook,
 * because `useAuth()` throws outside a `ClerkProvider` and hooks cannot be
 * called conditionally. In `e2e-fake` mode there is no provider to be inside
 * (see app/layout.tsx), so that branch must never reach `useAuth` at all.
 */
function ClerkTokenProvider({ children }: { children: ReactNode }) {
  const clerk = useAuth();
  const getToken = useCallback(() => clerk.getToken(), [clerk]);
  return <ResolvedWorkspaceProvider getToken={getToken}>{children}</ResolvedWorkspaceProvider>;
}

function E2eTokenProvider({ children }: { children: ReactNode }) {
  const getToken = useCallback(async () => e2eFakeToken(), []);
  return <ResolvedWorkspaceProvider getToken={getToken}>{children}</ResolvedWorkspaceProvider>;
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  return currentAuthMode() === 'e2e-fake' ? (
    <E2eTokenProvider>{children}</E2eTokenProvider>
  ) : (
    <ClerkTokenProvider>{children}</ClerkTokenProvider>
  );
}

function ResolvedWorkspaceProvider({
  getToken,
  children,
}: {
  getToken: () => Promise<string | null>;
  children: ReactNode;
}) {
  const [status, setStatus] = useState<WorkspaceStatus>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchMe(getToken)
      .then((result) => {
        if (cancelled) return;
        setMe(result);
        setStatus(result.workspaces.length > 0 ? 'ready' : 'no-membership');
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : 'Could not load your account.');
        setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [getToken]);

  const memberships = me?.workspaces ?? [];
  const workspace = memberships.find((m) => m.workspaceId === selected) ?? memberships[0] ?? null;

  return (
    <WorkspaceContext.Provider
      value={{
        status,
        workspace,
        memberships,
        userId: me?.userId ?? null,
        email: me?.email ?? null,
        error,
        getToken,
        selectWorkspace: setSelected,
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) {
    throw new Error('useWorkspace must be used within a WorkspaceProvider');
  }
  return ctx;
}
