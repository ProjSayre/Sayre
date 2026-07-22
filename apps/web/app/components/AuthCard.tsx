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
          <span className="brand-mark">S</span>
          sayre
        </Link>
        <h1>{login ? 'Welcome back' : 'Create your workspace'}</h1>
        <p>
          {login
            ? 'Sign in to continue exploring your engineering memory graph.'
            : 'Connect your team to a shared, queryable map of the codebase.'}
        </p>
        <form className="auth-form">
          {!login ? (
            <label className="auth-field">
              Name
              <input name="name" autoComplete="name" placeholder="Ada Lovelace" />
            </label>
          ) : null}
          <label className="auth-field">
            Work email
            <input name="email" type="email" autoComplete="email" placeholder="you@company.com" />
          </label>
          <label className="auth-field">
            Password
            <input
              name="password"
              type="password"
              autoComplete={login ? 'current-password' : 'new-password'}
              placeholder="••••••••••••"
            />
          </label>
          <Link className="auth-primary" href="/">
            {login ? 'Sign in to demo' : 'Create demo workspace'}
          </Link>
        </form>
        <div className="auth-switch">
          {login ? 'New to Sayre? ' : 'Already have an account? '}
          <Link href={login ? '/signup' : '/login'}>{login ? 'Create an account' : 'Sign in'}</Link>
        </div>
      </section>
    </main>
  );
}
