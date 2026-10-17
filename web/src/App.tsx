import { useEffect, useState } from 'react';
import { AuthProvider, useAuth } from './auth';
import { AppDataProvider, useApp } from './data';
import { Chat } from './pages/Chat';
import { Dashboard } from './pages/Dashboard';
import { Documents } from './pages/Documents';
import { Journal } from './pages/Journal';
import { Legal } from './pages/Legal';
import { Login } from './pages/Login';
import { Meetings } from './pages/Meetings';
import { Notifications } from './pages/Notifications';
import { Profile } from './pages/Profile';
import { ProjectDetail, Projects } from './pages/Projects';
import { TasksPage } from './pages/Tasks';
import { Team } from './pages/Team';
import { RealtimeProvider, useRealtime } from './realtime';
import { useRoute } from './route';
import { Avatar, Badge, ConfirmProvider, Icon, Logo, Modal, ToastProvider, type IconName } from './ui';

interface NavItem { id: string; label: string; icon: IconName }
const MAIN: NavItem[] = [
  { id: 'accueil', label: 'Accueil', icon: 'home' },
  { id: 'projets', label: 'Projets', icon: 'projects' },
  { id: 'taches', label: 'Tâches', icon: 'tasks' },
  { id: 'messages', label: 'Messages', icon: 'chat' },
  { id: 'rendez-vous', label: 'Rendez-vous', icon: 'calendar' },
  { id: 'documents', label: 'Documents', icon: 'folder' },
  { id: 'equipe', label: 'Équipe', icon: 'team' },
];
const PAGES = [...MAIN.map((n) => n.id), 'notifications', 'profil', 'journal'];

function Shell() {
  const { user } = useAuth();
  const { unreadMessages, unreadNotifs } = useApp();
  const { connected } = useRealtime();
  const route = useRoute();
  const [more, setMore] = useState(false);
  const wanted = PAGES.includes(route[0] ?? '') ? (route[0] as string) : 'accueil';
  const page = wanted === 'journal' && user?.role !== 'admin' ? 'accueil' : wanted; // le journal est réservé au Super Admin

  useEffect(() => {
    document.title = unreadMessages > 0 ? `(${unreadMessages}) LinkLink` : 'LinkLink';
  }, [unreadMessages]);
  useEffect(() => setMore(false), [page]);

  const badge = (id: string) => (id === 'messages' ? unreadMessages : 0);
  const isActive = (id: string) => page === id;
  const link = (id: string) => `#${id}`;

  const secondary: (NavItem & { count?: number })[] = [
    { id: 'rendez-vous', label: 'Rendez-vous', icon: 'calendar' },
    { id: 'documents', label: 'Documents', icon: 'folder' },
    { id: 'equipe', label: 'Équipe', icon: 'team' },
    { id: 'notifications', label: 'Notifications', icon: 'bell', count: unreadNotifs },
    { id: 'profil', label: 'Mon profil', icon: 'user' },
    ...(user?.role === 'admin' ? [{ id: 'journal', label: "Journal d'activité", icon: 'shield' as IconName }] : []),
  ];

  return (
    <div className="flex h-dvh flex-col md:flex-row">
      <a href="#contenu" className="skip-link" onClick={(e) => { e.preventDefault(); document.getElementById('contenu')?.focus(); }}>
        Aller au contenu
      </a>

      {/* Navigation latérale (ordinateur) : fond bleu nuit, logo sur tuile blanche (charte §3.3) */}
      <aside className="hidden w-60 shrink-0 flex-col bg-navy p-3 text-white md:flex">
        <a href="#accueil" className="mb-4 flex items-center justify-center rounded-2xl bg-white p-3" aria-label="LinkLink — Accueil">
          <Logo symbol className="h-14" />
        </a>
        <nav className="space-y-1" aria-label="Navigation principale">
          {MAIN.map((n) => (
            <a
              key={n.id}
              href={link(n.id)}
              aria-current={isActive(n.id) ? 'page' : undefined}
              className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold ${isActive(n.id) ? 'bg-electric text-white' : 'text-blue-100 hover:bg-white/10'}`}
            >
              <Icon name={n.icon} />
              {n.label}
              <Badge n={badge(n.id)} className="ml-auto" />
            </a>
          ))}
        </nav>
        <nav className="mt-auto space-y-1 border-t border-white/15 pt-3" aria-label="Compte">
          <a href="#notifications" aria-current={isActive('notifications') ? 'page' : undefined} className={`flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-semibold ${isActive('notifications') ? 'bg-electric' : 'text-blue-100 hover:bg-white/10'}`}>
            <Icon name="bell" /> Notifications <Badge n={unreadNotifs} className="ml-auto" />
          </a>
          {user?.role === 'admin' && (
            <a href="#journal" aria-current={isActive('journal') ? 'page' : undefined} className={`flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-semibold ${isActive('journal') ? 'bg-electric' : 'text-blue-100 hover:bg-white/10'}`}>
              <Icon name="shield" /> Journal
            </a>
          )}
          <a href="#profil" aria-current={isActive('profil') ? 'page' : undefined} className={`flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-semibold ${isActive('profil') ? 'bg-electric' : 'text-blue-100 hover:bg-white/10'}`}>
            {user && <Avatar name={user.name} size={26} />}
            <span className="min-w-0 truncate">{user?.name}</span>
          </a>
          <p className="px-3 pt-1 text-xs text-blue-200" role="status">{connected ? '● En ligne' : '○ Reconnexion…'}</p>
        </nav>
      </aside>

      <main id="contenu" tabIndex={-1} className="relative min-h-0 flex-1 outline-none">
        {!connected && (
          <p role="status" className="absolute inset-x-0 top-0 z-10 bg-amber-100 py-1 text-center text-xs font-semibold text-amber-900 md:hidden">Reconnexion…</p>
        )}
        {/* La messagerie reste montée pour conserver brouillons et position de lecture. */}
        <div className={page === 'messages' ? 'h-full' : 'hidden'}>
          <Chat active={page === 'messages'} />
        </div>
        {page === 'accueil' && <Dashboard />}
        {page === 'projets' && (route[1] ? <ProjectDetail key={route[1]} id={route[1]} tab={route[2]} taskId={route[2] === 'taches' ? route[3] : undefined} /> : <Projects />)}
        {page === 'taches' && <TasksPage taskId={route[1]} />}
        {page === 'rendez-vous' && <Meetings />}
        {page === 'documents' && <Documents />}
        {page === 'equipe' && <Team />}
        {page === 'notifications' && <Notifications />}
        {page === 'profil' && <Profile />}
        {page === 'journal' && user?.role === 'admin' && <Journal />}
      </main>

      {/* Barre du bas (téléphone) */}
      <nav aria-label="Navigation principale" className="grid shrink-0 grid-cols-5 border-t border-line bg-white pb-[env(safe-area-inset-bottom)] md:hidden">
        {[MAIN[0], MAIN[1], MAIN[2], MAIN[3]].map((n) => n && (
          <a key={n.id} href={link(n.id)} aria-current={isActive(n.id) ? 'page' : undefined} className={`relative flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-semibold ${isActive(n.id) ? 'text-electric' : 'text-slate'}`}>
            <Icon name={n.icon} />
            {n.label}
            <Badge n={badge(n.id)} className="absolute right-[18%] top-1 !min-w-4 !px-1 !text-[10px]" />
          </a>
        ))}
        <button onClick={() => setMore(true)} aria-haspopup="dialog" className={`relative flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-semibold ${['rendez-vous', 'documents', 'equipe', 'notifications', 'profil', 'journal'].includes(page) ? 'text-electric' : 'text-slate'}`}>
          <Icon name="more" />
          Plus
          <Badge n={unreadNotifs} className="absolute right-[18%] top-1 !min-w-4 !px-1 !text-[10px]" />
        </button>
      </nav>

      {more && (
        <Modal title="Plus" onClose={() => setMore(false)}>
          <ul className="space-y-1">
            {secondary.map((n) => (
              <li key={n.id}>
                <a href={link(n.id)} className="flex items-center gap-3 rounded-xl px-3 py-3 font-semibold hover:bg-mist">
                  <Icon name={n.icon} className="h-5 w-5 text-electric" />
                  {n.label}
                  <Badge n={n.count ?? 0} className="ml-auto" />
                </a>
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </div>
  );
}

function Gate() {
  const { user, loading } = useAuth();
  const route = useRoute();
  if (route[0] === 'legal') return <Legal doc={route[1]} standalone={!user} />;
  if (loading) return <p className="flex h-full items-center justify-center text-sm text-slate" role="status">Chargement…</p>;
  if (!user) return <Login />;
  return (
    // La clé force un état tout neuf quand on change de compte.
    <RealtimeProvider key={user.id}>
      <AppDataProvider>
        <Shell />
      </AppDataProvider>
    </RealtimeProvider>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <AuthProvider>
          <Gate />
        </AuthProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}
