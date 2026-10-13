import { useCallback, useEffect, useState } from 'react';
import { AuthProvider, useAuth } from './auth';
import { Chat } from './pages/Chat';
import { Documents } from './pages/Documents';
import { Login } from './pages/Login';
import { Meetings } from './pages/Meetings';
import { Team } from './pages/Team';
import { RealtimeProvider, useRealtime } from './realtime';
import { Icon, Logo } from './ui';

type Tab = 'messages' | 'rendez-vous' | 'documents' | 'equipe';

const TABS: { id: Tab; label: string; icon: 'chat' | 'calendar' | 'folder' | 'team' }[] = [
  { id: 'messages', label: 'Messages', icon: 'chat' },
  { id: 'rendez-vous', label: 'Rendez-vous', icon: 'calendar' },
  { id: 'documents', label: 'Documents', icon: 'folder' },
  { id: 'equipe', label: 'Équipe', icon: 'team' },
];

const readTab = (): Tab => {
  const hash = location.hash.replace('#', '') as Tab;
  return TABS.some((t) => t.id === hash) ? hash : 'messages';
};

function Shell() {
  const [tab, setTab] = useState<Tab>(readTab);
  const [unread, setUnread] = useState(0);
  const { connected } = useRealtime();

  useEffect(() => {
    const onHash = () => setTab(readTab());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    document.title = unread > 0 ? `(${unread}) LinkLink` : 'LinkLink';
  }, [unread]);

  const onUnreadChange = useCallback((n: number) => setUnread(n), []);
  const go = (t: Tab) => {
    location.hash = t;
    setTab(t);
  };

  return (
    <div className="flex h-dvh flex-col md:flex-row">
      {/* Navigation latérale (ordinateur) */}
      <aside className="hidden w-56 shrink-0 flex-col bg-teal-900 p-3 text-teal-50 md:flex">
        <div className="mb-4 flex items-center gap-2 px-2 py-2">
          <Logo className="h-9 w-9" />
          <span className="text-lg font-bold tracking-tight">LinkLink</span>
        </div>
        <nav className="space-y-1" aria-label="Navigation principale">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => go(t.id)}
              aria-current={tab === t.id ? 'page' : undefined}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium ${
                tab === t.id ? 'bg-teal-700 text-white' : 'hover:bg-teal-800'
              }`}
            >
              <Icon name={t.icon} />
              {t.label}
              {t.id === 'messages' && unread > 0 && (
                <span className="ml-auto rounded-full bg-amber-400 px-1.5 text-xs font-bold text-slate-900">{unread}</span>
              )}
            </button>
          ))}
        </nav>
        <p className="mt-auto px-3 text-xs text-teal-200">{connected ? '● En ligne' : '○ Reconnexion…'}</p>
      </aside>

      <main className="relative min-h-0 flex-1">
        {!connected && (
          <p className="absolute inset-x-0 top-0 z-10 bg-amber-100 py-1 text-center text-xs text-amber-900 md:hidden">Reconnexion…</p>
        )}
        {/* Les pages restent montées pour conserver leur état (brouillons, salon ouvert, messages non lus). */}
        <div className={tab === 'messages' ? 'h-full' : 'hidden'}>
          <Chat active={tab === 'messages'} onUnreadChange={onUnreadChange} />
        </div>
        <div className={tab === 'rendez-vous' ? 'h-full' : 'hidden'}>
          <Meetings />
        </div>
        <div className={tab === 'documents' ? 'h-full' : 'hidden'}>
          <Documents />
        </div>
        <div className={tab === 'equipe' ? 'h-full' : 'hidden'}>
          <Team />
        </div>
      </main>

      {/* Barre du bas (téléphone) */}
      <nav
        aria-label="Navigation principale"
        className="grid shrink-0 grid-cols-4 border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => go(t.id)}
            aria-current={tab === t.id ? 'page' : undefined}
            className={`relative flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium ${
              tab === t.id ? 'text-teal-700' : 'text-slate-500'
            }`}
          >
            <Icon name={t.icon} />
            {t.label}
            {t.id === 'messages' && unread > 0 && (
              <span className="absolute right-[22%] top-1 rounded-full bg-amber-400 px-1.5 text-[10px] font-bold text-slate-900">{unread}</span>
            )}
          </button>
        ))}
      </nav>
    </div>
  );
}

function Gate() {
  const { user, loading } = useAuth();
  if (loading) return <p className="flex h-full items-center justify-center text-sm text-slate-500">Chargement…</p>;
  if (!user) return <Login />;
  return (
    // La clé force un état tout neuf quand on change de compte.
    <RealtimeProvider key={user.id}>
      <Shell />
    </RealtimeProvider>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  );
}
