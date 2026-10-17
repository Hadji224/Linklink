import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, getToken, setToken, setUnauthorizedHandler } from './api';
import type { User } from './types';

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (input: { name: string; email: string; password: string; inviteCode: string; consent: boolean }) => Promise<void>;
  setUser: (u: User) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(() => getToken() !== null);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(logout);
    return () => setUnauthorizedHandler(null);
  }, [logout]);

  useEffect(() => {
    if (!getToken()) return;
    api<{ user: User }>('/me')
      .then((r) => setUser(r.user))
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
      login: async (email, password) => {
        const r = await api<{ token: string; user: User }>('/auth/login', {
          method: 'POST',
          body: { email, password },
        });
        setToken(r.token);
        setUser(r.user);
      },
      register: async (input) => {
        const r = await api<{ token: string; user: User }>('/auth/register', {
          method: 'POST',
          body: input,
        });
        setToken(r.token);
        setUser(r.user);
      },
    }),
    [user, loading, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth doit être utilisé dans <AuthProvider>');
  return ctx;
}
