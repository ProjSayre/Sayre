import Link from 'next/link';

interface AuthCardProps {
  mode: 'login' | 'signup';
}

export function AuthCard({ mode }: AuthCardProps) {
  const login = mode === 'login';

  return (
    <main className="auth-page">
      <section className="auth-card">
        <Link className="brand" href="/">
          sayre_
        </Link>
        <span className="auth-kind">{login ? 'sign in' : 'create account'}</span>
        <h1>{login ? 'Welcome back' : 'Create your workspace'}</h1>
        <p>
          {login
            ? 'Sign in to continue exploring your engineering memory graph.'
            : 'Connect your team to a shared, queryable map of the codebase.'}
        </p>
        {/*
          AUTH-01: real "Sign in with GitHub" is the only login/signup path —
          no password/email/name form. Plain <a>, not next/link: a full
          browser navigation is required to follow the 302 redirect chain to
          GitHub (client-side routing would not).
        */}
        <a className="auth-primary" href="/api/core/auth/github/login">
          Continue with GitHub
        </a>
        <p className="auth-note">
          GitHub is the only sign-in path. Sayre reads repository structure to
          build the graph; it never stores your source.
        </p>
        <div className="auth-switch">
          {login ? 'New to Sayre? ' : 'Already have an account? '}
          <Link href={login ? '/signup' : '/login'}>{login ? 'Create an account' : 'Sign in'}</Link>
        </div>
      </section>
    </main>
  );
}
