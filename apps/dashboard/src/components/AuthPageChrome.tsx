import type { CSSProperties } from 'react';

/**
 * Shared chrome for the two Clerk-hosted auth screens, so sign-in and sign-up
 * are visibly one product rather than two default widgets.
 */
export const AUTH_PAGE_MAIN: CSSProperties = {
  fontFamily: 'system-ui, sans-serif',
  minHeight: '100vh',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '3rem 1.5rem',
};

export function AuthPageHeading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <header style={{ textAlign: 'center', marginBottom: '2rem', maxWidth: '46ch' }}>
      <p
        style={{
          margin: 0,
          fontWeight: 600,
          letterSpacing: '0.02em',
          textTransform: 'uppercase',
          fontSize: '0.75rem',
          color: '#666',
        }}
      >
        Combat Creative OS
      </p>
      <h1 style={{ margin: '0.5rem 0 0.75rem', fontSize: '1.75rem' }}>{title}</h1>
      <p style={{ margin: 0, color: '#666', lineHeight: 1.5 }}>{subtitle}</p>
    </header>
  );
}
