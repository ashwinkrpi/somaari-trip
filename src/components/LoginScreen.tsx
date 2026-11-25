import { useState, type FormEvent } from 'react';
import { Compass, LogIn } from 'lucide-react';

interface LoginScreenProps {
  /** Shown above the form, e.g. after a session ended */
  notice?: string;
  onLoggedIn: () => void;
}

export function LoginScreen({ notice, onLoggedIn }: LoginScreenProps) {
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user, password, remember }),
      });
      if (res.ok) {
        setPassword('');
        onLoggedIn();
        return;
      }
      const body = await res.json().catch(() => null);
      setError(body?.error ?? `Login failed (HTTP ${res.status})`);
    } catch {
      setError('Could not reach the server');
    } finally {
      setBusy(false);
    }
  };

  const input =
    'w-full px-3 py-2 rounded-lg bg-neutral-950 border border-neutral-700 text-sm text-neutral-100 ' +
    'focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400';

  return (
    <div className="min-h-screen w-full bg-neutral-950 text-neutral-100 flex items-center justify-center px-4 font-sans">
      <main className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-2.5 mb-6">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-indigo-500 to-emerald-500 flex items-center justify-center shadow-md">
            <Compass className="w-5 h-5 text-white" />
          </div>
          <h1 className="text-lg font-bold tracking-tight">Somaari Trip</h1>
        </div>

        <form
          id="login-form"
          onSubmit={submit}
          className="bg-neutral-900 border border-neutral-800 rounded-xl p-5 shadow-xl space-y-4"
        >
          <h2 className="text-base font-semibold">Log in</h2>

          {notice && !error && (
            <p className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-md px-3 py-2">
              {notice}
            </p>
          )}
          {error && (
            <p role="alert" className="text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded-md px-3 py-2">
              {error}
            </p>
          )}

          <div className="space-y-1.5">
            <label htmlFor="login-user" className="block text-xs font-medium text-neutral-300">
              User name
            </label>
            <input
              id="login-user"
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              autoFocus
              value={user}
              onChange={(e) => setUser(e.target.value)}
              className={input}
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="login-password" className="block text-xs font-medium text-neutral-300">
              Password
            </label>
            <input
              id="login-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={input}
            />
          </div>

          <label className="flex items-center gap-2 text-xs text-neutral-300 cursor-pointer select-none">
            <input
              id="login-remember"
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="accent-indigo-500"
            />
            Keep me logged in for 30 days
          </label>

          <button
            type="submit"
            disabled={busy}
            className="w-full py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-sm font-medium flex items-center justify-center gap-2 transition"
          >
            <LogIn className="w-4 h-4" />
            {busy ? 'Logging in…' : 'Log in'}
          </button>

          <p className="text-[11px] text-neutral-400 leading-relaxed">
            Forgot it? On the server, run{' '}
            <code className="text-neutral-300 break-all">docker exec -it somaari-trip somaari-trip setpassword</code>
          </p>
        </form>
      </main>
    </div>
  );
}
