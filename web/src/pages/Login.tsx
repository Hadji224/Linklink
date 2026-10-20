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
  const [consent, setConsent] = useState(false);
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
      else await register({ name, email, password, inviteCode, consent });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Une erreur est survenue.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-full items-center justify-center bg-navy bg-[radial-gradient(circle_at_top,#135fea55,transparent_60%)] px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-5 flex flex-col items-center rounded-3xl bg-white p-4 text-center shadow-xl">
          <Logo className="h-28" />
          <p className="mt-1 text-sm text-slate">La plateforme de l'équipe : messages, projets, rendez-vous et documents.</p>
        </div>

        <form onSubmit={submit} className="card space-y-3 p-5 shadow-xl">
          <h1 className="text-lg font-bold">
            {mode === 'login' ? 'Connexion' : firstAccount ? 'Créer le compte Super Admin' : "Rejoindre l'équipe"}
          </h1>
          {firstAccount && (
            <p className="rounded-lg bg-blue-50 px-3 py-2 text-sm text-navy">
              Aucun compte n'existe encore : le premier compte créé sera <strong>Super Admin</strong>.
            </p>
          )}

          {mode === 'register' && (
            <label className="block">
              <span className="label">Nom complet</span>
              <input className="field mt-1" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
            </label>
          )}
          <label className="block">
            <span className="label">Adresse e-mail</span>
            <input className="field mt-1" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
          </label>
          <label className="block">
            <span className="label">Mot de passe</span>
            <input
              className="field mt-1"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              minLength={mode === 'register' ? 8 : undefined}
              required
            />
            {mode === 'register' && <span className="mt-1 block text-xs text-slate">8 caractères minimum.</span>}
          </label>
          {mode === 'register' && !firstAccount && (
            <label className="block">
              <span className="label">Code d'invitation</span>
              <input
                className="field mt-1 uppercase tracking-widest"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
                placeholder="XXXX-XXXX"
                autoCapitalize="characters"
                required
              />
              <span className="mt-1 block text-xs text-slate">À demander à un fondateur de LinkLink.</span>
            </label>
          )}
          {mode === 'register' && (
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1 h-5 w-5 shrink-0 accent-[#135fea]" checked={consent} onChange={(e) => setConsent(e.target.checked)} required />
              <span>
                J'ai lu et j'accepte les{' '}
                <a href="#legal/cgu" className="font-semibold text-electric underline">conditions d'utilisation</a> et la{' '}
                <a href="#legal/confidentialite" className="font-semibold text-electric underline">politique de confidentialité</a>.
              </span>
            </label>
          )}

          <ErrorNote>{error}</ErrorNote>
          <button className="btn btn-primary w-full" disabled={busy || hasUsers === null || (mode === 'register' && !consent)}>
            {busy ? 'Patientez…' : mode === 'login' ? 'Se connecter' : 'Créer mon compte'}
          </button>

          {!firstAccount && (
            <button
              type="button"
              className="w-full py-2 text-center text-sm font-semibold text-electric underline"
              onClick={() => {
                setMode(mode === 'login' ? 'register' : 'login');
                setError('');
              }}
            >
              {mode === 'login' ? "Pas encore de compte ? J'ai un code d'invitation" : 'Déjà un compte ? Se connecter'}
            </button>
          )}
        </form>
        <p className="mt-4 text-center text-xs text-blue-200">
          <a href="#legal/cgu" className="underline">Conditions d'utilisation</a> · <a href="#legal/confidentialite" className="underline">Confidentialité</a> · {__APP_VERSION__}
        </p>
      </div>
    </main>
  );
}
