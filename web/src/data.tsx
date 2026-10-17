import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from './api';
import { useAuth } from './auth';
import { useRealtime, useRealtimeEvents } from './realtime';
import type { Channel, Member, Notif, Project } from './types';
import { useToast } from './ui';

interface AppData {
  members: Member[];
  memberById: (id: string) => Member | undefined;
  refreshMembers: () => Promise<void>;
  projects: Project[];
  refreshProjects: () => Promise<void>;
  channels: Channel[];
  refreshChannels: () => Promise<void>;
  unreadMessages: number;
  /** Salon actuellement affiché (null si l'écran Messages n'est pas visible) : ses messages arrivent « lus ». */
  setOpenChannel: (id: string | null) => void;
  notifications: Notif[];
  unreadNotifs: number;
  markNotifsRead: (ids?: string[]) => Promise<void>;
  refreshNotifs: () => Promise<void>;
}

const Ctx = createContext<AppData | null>(null);

export function AppDataProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { epoch } = useRealtime();
  const toast = useToast();
  const [members, setMembers] = useState<Member[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [notifications, setNotifications] = useState<Notif[]>([]);
  const [unreadNotifs, setUnreadNotifs] = useState(0);
  const openChannel = useRef<string | null>(null);

  const refreshMembers = useCallback(async () => {
    setMembers((await api<{ members: Member[] }>('/members')).members);
  }, []);
  const refreshProjects = useCallback(async () => {
    setProjects((await api<{ projects: Project[] }>('/projects')).projects);
  }, []);
  const refreshChannels = useCallback(async () => {
    setChannels((await api<{ channels: Channel[] }>('/channels')).channels);
  }, []);
  const refreshNotifs = useCallback(async () => {
    const r = await api<{ notifications: Notif[]; unread: number }>('/notifications');
    setNotifications(r.notifications);
    setUnreadNotifs(r.unread);
  }, []);

  // Chargement initial, puis après chaque (re)connexion du temps réel.
  useEffect(() => {
    void Promise.allSettled([refreshMembers(), refreshProjects(), refreshChannels(), refreshNotifs()]);
  }, [epoch, refreshMembers, refreshProjects, refreshChannels, refreshNotifs]);

  const markRead = useCallback((id: string) => {
    void api(`/channels/${id}/read`, { method: 'POST' }).catch(() => {});
  }, []);

  const setOpenChannel = useCallback(
    (id: string | null) => {
      openChannel.current = id;
      if (id) {
        setChannels((l) => l.map((c) => (c.id === id && c.unread ? { ...c, unread: 0 } : c)));
        markRead(id);
      }
    },
    [markRead],
  );

  useRealtimeEvents((e) => {
    switch (e.type) {
      case 'message': {
        const m = e.message;
        const mine = m.user.id === user?.id;
        const watching = openChannel.current === m.channelId && !document.hidden;
        setChannels((l) => {
          if (!l.some((c) => c.id === m.channelId)) {
            void refreshChannels();
            return l;
          }
          return l
            .map((c) => (c.id === m.channelId ? { ...c, lastAt: m.createdAt, unread: !mine && !watching ? c.unread + 1 : c.unread } : c))
            .sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? ''));
        });
        if (watching && !mine) markRead(m.channelId);
        break;
      }
      case 'channel':
        void refreshChannels();
        break;
      case 'members':
        void refreshMembers();
        break;
      case 'presence':
        setMembers((l) => l.map((m) => ({ ...m, online: e.online.includes(m.id) })));
        break;
      case 'project':
        void refreshProjects();
        void refreshChannels();
        break;
      case 'task':
        void refreshProjects(); // la progression automatique change
        break;
      case 'notification':
        setNotifications((l) => [e.notification, ...l].slice(0, 60));
        setUnreadNotifs((n) => n + 1);
        toast.info(e.notification.title);
        break;
    }
  });

  // Quand on revient sur la page, le salon ouvert redevient « lu ».
  useEffect(() => {
    const on = () => {
      if (!document.hidden && openChannel.current) setOpenChannel(openChannel.current);
    };
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, [setOpenChannel]);

  const markNotifsRead = useCallback(async (ids?: string[]) => {
    await api('/notifications/read', { method: 'POST', body: ids ? { ids } : {} });
    const t = new Date().toISOString();
    setNotifications((l) => l.map((n) => (!ids || ids.includes(n.id) ? { ...n, readAt: n.readAt ?? t } : n)));
    setUnreadNotifs((n) => (ids ? Math.max(0, n - ids.length) : 0));
  }, []);

  const value = useMemo<AppData>(
    () => ({
      members,
      memberById: (id) => members.find((m) => m.id === id),
      refreshMembers,
      projects,
      refreshProjects,
      channels,
      refreshChannels,
      unreadMessages: channels.reduce((n, c) => n + c.unread, 0),
      setOpenChannel,
      notifications,
      unreadNotifs,
      markNotifsRead,
      refreshNotifs,
    }),
    [members, projects, channels, notifications, unreadNotifs, refreshMembers, refreshProjects, refreshChannels, setOpenChannel, markNotifsRead, refreshNotifs],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useApp doit être utilisé dans <AppDataProvider>');
  return c;
}
