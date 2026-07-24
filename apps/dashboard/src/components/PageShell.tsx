'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useSession } from '@/lib/session';

export function PageShell({ title, children }: { title: string; children: ReactNode }) {
  const { session, clearSession } = useSession();

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
        {session && (
          <button
            type="button"
            onClick={clearSession}
            style={{
              fontSize: '0.85rem',
              color: '#666',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            Switch identity
          </button>
        )}
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
