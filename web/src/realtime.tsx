import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getToken } from './api';
import type { RealtimeEvent } from './types';

type Listener = (event: RealtimeEvent) => void;

interface RealtimeState {
  subscribe: (listener: Listener) => () => void;
  /** Augmente à chaque (re)connexion : les pages s'en servent pour recharger leurs données. */
  epoch: number;
  connected: boolean;
}

const RealtimeContext = createContext<RealtimeState | null>(null);

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const listeners = useRef(new Set<Listener>());
  const [epoch, setEpoch] = useState(0);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let stopped = false;

    const connect = () => {
      const token = getToken();
      if (!token || stopped) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);
      socket.onopen = () => {
        attempt = 0;
        setConnected(true);
        setEpoch((e) => e + 1);
      };
      socket.onmessage = (e) => {
        try {
          const event = JSON.parse(String(e.data)) as RealtimeEvent;
          listeners.current.forEach((l) => l(event));
        } catch {
          /* message ignoré */
        }
      };
      socket.onclose = () => {
        setConnected(false);
        if (stopped) return;
        attempt += 1;
        timer = setTimeout(connect, Math.min(1000 * 2 ** attempt, 15_000));
      };
    };

    const onVisible = () => {
      // Au retour sur l'application (téléphone déverrouillé), on reconnecte tout de suite.
      if (document.visibilityState === 'visible' && (!socket || socket.readyState === WebSocket.CLOSED)) {
        clearTimeout(timer);
        connect();
      }
    };

    connect();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      socket?.close();
    };
  }, []);

  const value = useMemo<RealtimeState>(
    () => ({
      subscribe: (listener) => {
        listeners.current.add(listener);
        return () => listeners.current.delete(listener);
      },
      epoch,
      connected,
    }),
    [epoch, connected],
  );

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime() {
  const ctx = useContext(RealtimeContext);
  if (!ctx) throw new Error('useRealtime doit être utilisé dans <RealtimeProvider>');
  return ctx;
}

/** Écoute les événements temps réel pendant la vie du composant. */
export function useRealtimeEvents(handler: Listener) {
  const { subscribe } = useRealtime();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => subscribe((e) => ref.current(e)), [subscribe]);
}
