import { SignIn } from '@clerk/nextjs';
import Link from 'next/link';
import { AUTH_PAGE_MAIN, AuthPageHeading } from '@/components/AuthPageChrome';

/**
 * Scaffolded by `clerk init`, then restyled to match the dashboard's existing
 * look (system-ui, the same neutral palette and `Combat Creative OS` wordmark
 * the nav uses) instead of a bare centred widget on a blank page.
 */
export default function SignInPage() {
  return (
    <main style={AUTH_PAGE_MAIN}>
      <AuthPageHeading
        title="Sign in"
        subtitle="Your workspace and role live in Combat Creative OS, not in your sign-in account — you will land in the workspaces you are a member of."
      />
      <SignIn />
      <p style={{ marginTop: '1.5rem', fontSize: '0.85rem', color: '#666' }}>
        No account yet? <Link href="/sign-up">Create one</Link>.
      </p>
    </main>
  );
}
