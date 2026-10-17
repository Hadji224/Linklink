import type { IncomingMessage, Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { userFromToken } from './auth.js';

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

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const user = userFromToken(url.searchParams.get('token'));
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.set(ws, user.id);
      emitAll({ type: 'presence', online: onlineUserIds() });
      const drop = () => {
        if (clients.delete(ws)) emitAll({ type: 'presence', online: onlineUserIds() });
      };
      ws.on('close', drop);
      ws.on('error', drop);
    });
  });

  setInterval(() => {
    for (const ws of clients.keys()) if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 30_000).unref();
}
