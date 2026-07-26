'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { Show, SignInButton, SignUpButton, UserButton } from '@clerk/nextjs';
import { currentAuthMode } from '@/lib/auth-mode';
import { useWorkspace } from '@/lib/workspace';

const NAV_BUTTON: React.CSSProperties = {
  fontSize: '0.85rem',
  fontWeight: 500,
  lineHeight: 1,
  padding: '0.5rem 0.9rem',
  borderRadius: 6,
  border: '1px solid #ddd',
  background: '#fff',
  color: '#111',
  cursor: 'pointer',
};

const NAV_BUTTON_PRIMARY: React.CSSProperties = {
  ...NAV_BUTTON,
  border: '1px solid #111',
  background: '#111',
  color: '#fff',
};

/**
 * AAMP-1 step 2: the nav's right-hand side is Clerk's own session UI — sign
 * in / sign up while signed out, the account menu while signed in. The old
 * "Switch identity" button is gone with the identity picker it belonged to;
 * signing out is now a real session operation, not clearing localStorage.
 */
function SessionControls() {
  const { workspace } = useWorkspace();

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
      {workspace && (
        <span style={{ fontSize: '0.8rem', color: '#666' }} data-testid="workspace-role">
          {workspace.role}
        </span>
      )}
      {/* `Show` is @clerk/nextjs v7's replacement for SignedIn/SignedOut. */}
      <Show when="signed-out">
        <SignInButton mode="modal">
          <button type="button" style={NAV_BUTTON}>
            Sign in
          </button>
        </SignInButton>
        <SignUpButton mode="modal">
          <button type="button" style={NAV_BUTTON_PRIMARY}>
            Sign up
          </button>
        </SignUpButton>
      </Show>
      <Show when="signed-in">
        <UserButton />
      </Show>
    </div>
  );
}

export function PageShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', maxWidth: 960 }}>
      <nav
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '1.5rem',
          paddingBottom: '1rem',
          borderBottom: '1px solid #ddd',
        }}
      >
        <Link href="/" style={{ fontWeight: 600, textDecoration: 'none', color: 'inherit' }}>
          Combat Creative OS
        </Link>
        {/* Clerk's session components need a ClerkProvider, which e2e-fake mode
            deliberately omits (see lib/auth-mode.ts). */}
        {currentAuthMode() === 'clerk' && <SessionControls />}
      </nav>
      <h1 style={{ marginTop: 0 }}>{title}</h1>
      {children}
    </main>
  );
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <p role="status" aria-live="polite" style={{ color: '#666' }}>
      {label}
    </p>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <p
      role="alert"
      style={{ color: '#b00020', background: '#fdecea', padding: '0.75rem', borderRadius: 4 }}
    >
      {message}
    </p>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <p style={{ color: '#666', fontStyle: 'italic' }} data-testid="empty-state">
      {children}
    </p>
  );
}
