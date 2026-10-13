import type { IncomingMessage, Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { userFromToken } from './auth.js';

export type RealtimeEvent =
  | { type: 'message'; message: unknown }
  | { type: 'meeting'; meetingId: string }
  | { type: 'file'; fileId: string };

const clients = new Set<WebSocket>();

export function broadcast(event: RealtimeEvent) {
  const data = JSON.stringify(event);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

export function attachRealtime(server: Server) {
  const wss = new WebSocketServer({ noServer: true });

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
      clients.add(ws);
      ws.on('close', () => clients.delete(ws));
      ws.on('error', () => clients.delete(ws));
    });
  });

  // Ping régulier pour garder les connexions mobiles vivantes.
  setInterval(() => {
    for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 30_000).unref();
}
