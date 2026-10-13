import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorNote, Logo } from '../ui';

export function Login() {
  const { login, register } = useAuth();
  const [hasUsers, setHasUsers] = useState<boolean | null>(null);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ hasUsers: boolean }>('/setup')
      .then((r) => {
        setHasUsers(r.hasUsers);
        if (!r.hasUsers) setMode('register');
      })
      .catch(() => setHasUsers(true));
  }, []);

  const firstAccount = hasUsers === false;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (mode === 'login') await login(email, password);
      else await register({ name, email, password, inviteCode });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Une erreur est survenue.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-full items-center justify-center bg-gradient-to-b from-teal-800 to-teal-950 px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center text-white">
          <Logo className="h-16 w-16" />
          <h1 className="mt-3 text-3xl font-bold tracking-tight">LinkLink</h1>
          <p className="mt-1 text-sm text-teal-100">Messages, rendez-vous et documents de l'équipe</p>
        </div>

        <form onSubmit={submit} className="card space-y-3 p-5 shadow-xl">
          <h2 className="text-lg font-semibold">
            {mode === 'login' ? 'Connexion' : firstAccount ? 'Créer le compte administrateur' : 'Rejoindre l\'équipe'}
          </h2>
          {firstAccount && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
              Aucun compte n'existe encore : le premier compte créé sera administrateur.
            </p>
          )}

          {mode === 'register' && (
            <label className="block text-sm font-medium">
              Nom complet
              <input className="field mt-1" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
            </label>
          )}
          <label className="block text-sm font-medium">
            Adresse e-mail
            <input className="field mt-1" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
          </label>
          <label className="block text-sm font-medium">
            Mot de passe
            <input
              className="field mt-1"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              minLength={mode === 'register' ? 8 : undefined}
              required
            />
            {mode === 'register' && <span className="mt-1 block text-xs font-normal text-slate-500">8 caractères minimum.</span>}
          </label>
          {mode === 'register' && !firstAccount && (
            <label className="block text-sm font-medium">
              Code d'invitation
              <input
                className="field mt-1 uppercase tracking-widest"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
                placeholder="XXXX-XXXX"
                autoCapitalize="characters"
                required
              />
              <span className="mt-1 block text-xs font-normal text-slate-500">À demander à un administrateur de LinkLink.</span>
            </label>
          )}

          <ErrorNote>{error}</ErrorNote>
          <button className="btn btn-primary w-full" disabled={busy || hasUsers === null}>
            {busy ? 'Patientez…' : mode === 'login' ? 'Se connecter' : 'Créer mon compte'}
          </button>

          {!firstAccount && (
            <button
              type="button"
              className="w-full text-center text-sm text-teal-800 underline"
              onClick={() => {
                setMode(mode === 'login' ? 'register' : 'login');
                setError('');
              }}
            >
              {mode === 'login' ? "Pas encore de compte ? J'ai un code d'invitation" : 'Déjà un compte ? Se connecter'}
            </button>
          )}
        </form>
      </div>
    </main>
  );
}
