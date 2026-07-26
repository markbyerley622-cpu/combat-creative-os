import { ClerkProvider } from '@clerk/nextjs';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { currentAuthMode } from '@/lib/auth-mode';
import { WorkspaceProvider } from '@/lib/workspace';

export const metadata: Metadata = {
  title: 'Combat Creative OS — Dashboard',
  description:
    'Orchestrator control surface for Combat Creative OS approval gates and run inspection.',
};

/**
 * AAMP-1 step 2. `ClerkProvider` wraps the whole app so `useAuth()` can mint a
 * session token anywhere in the tree; `WorkspaceProvider` sits inside it,
 * because resolving the caller's workspaces requires that token.
 *
 * In `e2e-fake` mode `ClerkProvider` is omitted — it requires a publishable key
 * the Playwright suite deliberately does not have. See lib/auth-mode.ts for why
 * that grants nothing: `apps/api` verifies every token independently.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  const body = <WorkspaceProvider>{children}</WorkspaceProvider>;
  return (
    <html lang="en">
      <body>{currentAuthMode() === 'clerk' ? <ClerkProvider>{body}</ClerkProvider> : body}</body>
    </html>
  );
}
