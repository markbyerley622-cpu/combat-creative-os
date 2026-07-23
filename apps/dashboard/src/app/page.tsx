import { DOMAIN_PACKAGE_NAME } from '@combat/domain';

export default function DashboardHomePage() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '3rem' }}>
      <h1>Combat Creative OS</h1>
      <p>Repository foundation milestone. No business workflows are wired up yet.</p>
      <p>
        This UI is a thin client only — it holds no business logic, no database access, and no
        Temporal client. Every command and query goes through <code>apps/api</code>.
      </p>
      <p style={{ color: '#666', fontSize: '0.85rem' }}>
        Cross-package wiring check: rendering via <code>{DOMAIN_PACKAGE_NAME}</code>.
      </p>
    </main>
  );
}
