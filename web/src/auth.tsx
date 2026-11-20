import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, getToken, setToken, setUnauthorizedHandler } from './api';
import { clearLocalFiles } from './fileCache';
import type { User } from './types';

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (input: { name: string; email: string; password: string; inviteCode: string; consent: boolean }) => Promise<void>;
  setUser: (u: User) => void;
  /** Recharge le profil, les fonctions et les capacités (après un changement de fonction, de mandat ou de rôle). */
  refreshMe: () => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(() => getToken() !== null);

  // Session expirée : on garde les copies locales des fichiers (comme WhatsApp, elles restent sur l'appareil).
  const expire = useCallback(() => {
    setToken(null);
    setUser(null);
  }, []);
  // Déconnexion volontaire : on efface aussi les fichiers de l'équipe gardés sur cet appareil (ordinateur partagé).
  const logout = useCallback(() => {
    void clearLocalFiles();
    expire();
  }, [expire]);

  useEffect(() => {
    setUnauthorizedHandler(expire);
    return () => setUnauthorizedHandler(null);
  }, [expire]);

  const refreshMe = useCallback(async () => {
    const r = await api<{ user: User; can?: User['can'] }>('/me');
    setUser({ ...r.user, can: r.can });
  }, []);

  useEffect(() => {
    if (!getToken()) return;
    api<{ user: User; can?: User['can'] }>('/me')
      .then((r) => setUser({ ...r.user, can: r.can }))
      .catch(() => {
        /* 401 : déjà géré par le gestionnaire ; autre erreur : on affiche la connexion */
      })
      .finally(() => setLoading(false));
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      loading,
      logout,
      setUser,
      refreshMe,
      login: async (email, password) => {
        const r = await api<{ token: string; user: User }>('/auth/login', {
          method: 'POST',
          body: { email, password },
        });
        setToken(r.token);
        setUser(r.user);
        void api<{ user: User; can?: User['can'] }>('/me').then((m) => setUser({ ...m.user, can: m.can })).catch(() => {});
      },
      register: async (input) => {
        const r = await api<{ token: string; user: User }>('/auth/register', {
          method: 'POST',
          body: input,
        });
        setToken(r.token);
        setUser(r.user);
        void api<{ user: User; can?: User['can'] }>('/me').then((m) => setUser({ ...m.user, can: m.can })).catch(() => {});
      },
    }),
    [user, loading, logout, refreshMe],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth doit être utilisé dans <AuthProvider>');
  return ctx;
}
