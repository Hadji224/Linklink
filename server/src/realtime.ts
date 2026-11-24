import type { IncomingMessage, Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import crypto from 'node:crypto';
import { activeUserById } from './auth.js';
import { db, now } from './db.js';

export type RealtimeEvent =
  | { type: 'message'; message: unknown }
  | { type: 'channel'; channelId?: string }
  | { type: 'meeting'; meetingId: string }
  | { type: 'file'; fileId?: string }
  | { type: 'task'; taskId: string; projectId: string }
  | { type: 'project'; projectId: string }
  | { type: 'members' }
  | { type: 'notification'; notification: unknown }
  | { type: 'presence'; online: string[] };

const clients = new Map<WebSocket, string>(); // socket -> userId
const alive = new WeakMap<WebSocket, boolean>();
const MAX_SOCKETS_PER_USER = 8;

/** Origines autorisées à ouvrir un WebSocket : l'interface hébergée (CORS_ORIGIN, APP_URL) ou le serveur lui-même. Sans en-tête Origin (hors navigateur) : le ticket suffit. */
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  const allowed = [...(process.env.CORS_ORIGIN ?? '').split(','), process.env.APP_URL ?? ''].map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);
  if (allowed.includes(origin)) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/** Échange un ticket (usage unique, 30 s) contre l'identifiant du compte. */
async function consumeTicket(ticket: string | null) {
  if (!ticket || ticket.length > 100) return null;
  const hash = crypto.createHash('sha256').update(ticket).digest('hex');
  const row = await db.get<{ user_id: string }>('DELETE FROM ws_tickets WHERE hash = ? AND expires_at > ? RETURNING user_id', hash, now());
  return row ? await activeUserById(row.user_id) : null;
}

export const onlineUserIds = () => [...new Set(clients.values())];

/** Envoie l'événement uniquement aux utilisateurs listés (les données privées ne fuient jamais). */
export function emitTo(userIds: Iterable<string>, event: RealtimeEvent) {
  const set = new Set(userIds);
  const data = JSON.stringify(event);
  for (const [ws, id] of clients) if (set.has(id) && ws.readyState === WebSocket.OPEN) ws.send(data);
}

/** Signal sans donnée sensible, pour tout le monde (« rafraîchis-toi »). */
export function emitAll(event: RealtimeEvent) {
  const data = JSON.stringify(event);
  for (const ws of clients.keys()) if (ws.readyState === WebSocket.OPEN) ws.send(data);
}

export function disconnectUser(userId: string) {
  for (const [ws, id] of clients) if (id === userId) ws.close(4001, 'session expirée');
}

export function attachRealtime(server: Server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

  server.on('upgrade', async (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    if (!originAllowed(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    let user: Awaited<ReturnType<typeof consumeTicket>> = null;
    try {
      user = await consumeTicket(url.searchParams.get('ticket')); // jamais le jeton de session dans l'adresse
    } catch (e) {
      console.error('WebSocket : vérification impossible', e);
    }
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      // Plafond par compte : au-delà, la connexion la plus ancienne est fermée.
      const mine = [...clients].filter(([, id]) => id === user.id).map(([w]) => w);
      for (const old of mine.slice(0, Math.max(0, mine.length - MAX_SOCKETS_PER_USER + 1))) old.close(4002, 'trop de connexions');
      clients.set(ws, user.id);
      alive.set(ws, true);
      ws.on('pong', () => alive.set(ws, true));
      emitAll({ type: 'presence', online: onlineUserIds() });
      const drop = () => {
        if (clients.delete(ws)) emitAll({ type: 'presence', online: onlineUserIds() });
      };
      ws.on('close', drop);
      ws.on('error', drop);
    });
  });

  // Une connexion qui ne répond plus au ping est coupée (sinon la présence « en ligne » resterait fausse).
  setInterval(() => {
    for (const ws of clients.keys()) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }
  }, 30_000).unref();
}
