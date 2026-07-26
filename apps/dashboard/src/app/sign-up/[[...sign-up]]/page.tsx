import { SignUp } from '@clerk/nextjs';
import Link from 'next/link';
import { AUTH_PAGE_MAIN, AuthPageHeading } from '@/components/AuthPageChrome';

/** See sign-in/[[...sign-in]]/page.tsx — same scaffold, same restyling. */
export default function SignUpPage() {
  return (
    <main style={AUTH_PAGE_MAIN}>
      <AuthPageHeading
        title="Create your account"
        subtitle="Signing up proves who you are. Access to a workspace is granted separately by a workspace owner, so a new account starts with no campaigns until you are added."
      />
      <SignUp />
      <p style={{ marginTop: '1.5rem', fontSize: '0.85rem', color: '#666' }}>
        Already have an account? <Link href="/sign-in">Sign in</Link>.
      </p>
    </main>
  );
}
