import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../auth.js';
import { logActivity } from '../activity.js';
import { db, now, uid } from '../db.js';
import { HttpError, idParam, me, parse, type AuthUser } from '../http.js';
import { findMentions } from '../mentions.js';
import { notify } from '../notify.js';
import { assertCanPost, canAccessChannel, channelAudience, channelForAccess, getChannel, type ChannelRow } from '../perm.js';
import { emitAll, emitTo } from '../realtime.js';

export const channelsApi = Router();

interface MessageJoinRow {
  id: string; channel_id: string; body: string; created_at: string;
  uid: string; uname: string;
  fid: string | null; fname: string | null; fsize: number | null; fmime: string | null;
}

const MESSAGE_SELECT = `
  SELECT m.id, m.channel_id, m.body, m.created_at, u.id AS uid, u.name AS uname,
         f.id AS fid, f.name AS fname, f.size AS fsize, f.mime AS fmime
  FROM messages m JOIN users u ON u.id = m.user_id LEFT JOIN files f ON f.id = m.file_id`;

export function shapeMessage(r: MessageJoinRow) {
  return {
    id: r.id,
    channelId: r.channel_id,
    body: r.body,
    createdAt: r.created_at,
    user: { id: r.uid, name: r.uname },
    file: r.fid ? { id: r.fid, name: r.fname, size: r.fsize, mime: r.fmime } : null,
  };
}

export const loadMessage = (id: string) => shapeMessage(db.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).get(id) as unknown as MessageJoinRow);

/** Enregistre un message, le diffuse au bon public et notifie les personnes citées. */
export function postMessage(channel: ChannelRow, user: { id: string; name: string }, body: string, fileId: string | null = null) {
  const id = uid();
  db.prepare('INSERT INTO messages (id,channel_id,user_id,body,file_id,created_at) VALUES (?,?,?,?,?,?)').run(id, channel.id, user.id, body, fileId, now());
  db.prepare(
    `INSERT INTO channel_reads (channel_id,user_id,last_read_at) VALUES (?,?,?)
     ON CONFLICT(channel_id,user_id) DO UPDATE SET last_read_at = excluded.last_read_at`,
  ).run(channel.id, user.id, now());
  const message = loadMessage(id);
  const audience = channelAudience(channel);
  emitTo(audience, { type: 'message', message });
  if (channel.kind !== 'dm' && body) {
    for (const m of findMentions(body, audience)) {
      if (m !== user.id) {
        notify({ userId: m, type: 'mention', title: `${user.name} vous a mentionné dans #${channel.name}`, body: body.slice(0, 140), link: '#messages', email: false });
      }
    }
  }
  return message;
}

function channelShape(c: ChannelRow, userId: string) {
  const peerId = c.kind === 'dm' ? (c.dm_a === userId ? c.dm_b : c.dm_a) : null;
  const peer = peerId ? (db.prepare('SELECT id, name FROM users WHERE id = ?').get(peerId) as { id: string; name: string } | undefined) : undefined;
  const unread = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages m
         WHERE m.channel_id = ? AND m.user_id <> ?
           AND m.created_at > COALESCE((SELECT last_read_at FROM channel_reads WHERE channel_id = ? AND user_id = ?),
                                       (SELECT created_at FROM users WHERE id = ?))`,
      )
      .get(c.id, userId, c.id, userId, userId) as { n: number }
  ).n;
  const last = db.prepare('SELECT created_at FROM messages WHERE channel_id = ? ORDER BY created_at DESC LIMIT 1').get(c.id) as { created_at: string } | undefined;
  return {
    id: c.id,
    kind: c.kind,
    name: c.kind === 'dm' ? (peer?.name ?? 'Compte supprimé') : c.name,
    description: c.description,
    adminOnly: c.admin_only === 1,
    projectId: c.project_id,
    peer: peer ?? null,
    unread,
    lastAt: last?.created_at ?? null,
  };
}

export function unreadByChannel(user: AuthUser) {
  const rows = db.prepare('SELECT * FROM channels').all() as unknown as ChannelRow[];
  return rows.filter((c) => canAccessChannel(user, c)).map((c) => channelShape(c, user.id)).filter((c) => c.unread > 0);
}

channelsApi.get('/channels', (req, res) => {
  const rows = db.prepare('SELECT * FROM channels ORDER BY admin_only DESC, name').all() as unknown as ChannelRow[];
  const visible = rows.filter((c) => canAccessChannel(me(req), c)).map((c) => channelShape(c, me(req).id));
  visible.sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? ''));
  res.json({ channels: visible });
});

channelsApi.post('/channels', requireAdmin, (req, res) => {
  const input = parse(
    z.object({
      name: z.string().trim().toLowerCase().min(2, 'Le nom doit faire au moins 2 caractères.').max(30).regex(/^[\p{L}\p{N}-]+$/u, 'Lettres, chiffres et tirets uniquement.'),
      description: z.string().trim().max(200).optional().default(''),
      adminOnly: z.boolean().optional().default(false),
    }),
    req.body,
  );
  if (db.prepare("SELECT 1 FROM channels WHERE name = ? AND kind = 'channel'").get(input.name)) throw new HttpError(409, 'Ce salon existe déjà.');
  const id = uid();
  db.prepare('INSERT INTO channels (id,kind,name,description,admin_only,created_at) VALUES (?,?,?,?,?,?)').run(id, 'channel', input.name, input.description, input.adminOnly ? 1 : 0, now());
  logActivity(me(req), 'create', 'channel', id, `Salon #${input.name} créé`);
  emitAll({ type: 'channel' });
  res.status(201).json({ channel: channelShape(getChannel(id), me(req).id) });
});

// Messages directs : crée (ou retrouve) la conversation entre deux personnes.
channelsApi.post('/dms', (req, res) => {
  const { userId } = parse(z.object({ userId: z.string() }), req.body);
  if (userId === me(req).id) throw new HttpError(400, 'Choisissez une autre personne.');
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) throw new HttpError(404, 'Membre introuvable.');
  const [a, b] = [me(req).id, userId].sort() as [string, string];
  let c = db.prepare("SELECT * FROM channels WHERE kind='dm' AND dm_a = ? AND dm_b = ?").get(a, b) as unknown as ChannelRow | undefined;
  if (!c) {
    const id = uid();
    db.prepare("INSERT INTO channels (id,kind,name,dm_a,dm_b,created_at) VALUES (?, 'dm', 'dm', ?, ?, ?)").run(id, a, b, now());
    c = getChannel(id);
    emitTo([a, b], { type: 'channel', channelId: id });
  }
  res.json({ channel: channelShape(c, me(req).id) });
});

channelsApi.get('/channels/:id/messages', (req, res) => {
  const channel = channelForAccess(me(req), idParam(req));
  const before = typeof req.query.before === 'string' ? req.query.before : undefined;
  const rows = (
    before
      ? db.prepare(`${MESSAGE_SELECT} WHERE m.channel_id = ? AND m.created_at < ? ORDER BY m.created_at DESC LIMIT 50`).all(channel.id, before)
      : db.prepare(`${MESSAGE_SELECT} WHERE m.channel_id = ? ORDER BY m.created_at DESC LIMIT 50`).all(channel.id)
  ) as unknown as MessageJoinRow[];
  res.json({ messages: rows.reverse().map(shapeMessage), hasMore: rows.length === 50 });
});

channelsApi.post('/channels/:id/messages', (req, res) => {
  const channel = channelForAccess(me(req), idParam(req));
  const { body } = parse(z.object({ body: z.string().trim().min(1, 'Message vide.').max(4000, 'Message trop long.') }), req.body);
  assertCanPost(me(req), channel);
  res.status(201).json({ message: postMessage(channel, me(req), body) });
});

channelsApi.post('/channels/:id/read', (req, res) => {
  const channel = channelForAccess(me(req), idParam(req));
  db.prepare(
    `INSERT INTO channel_reads (channel_id,user_id,last_read_at) VALUES (?,?,?)
     ON CONFLICT(channel_id,user_id) DO UPDATE SET last_read_at = excluded.last_read_at`,
  ).run(channel.id, me(req).id, now());
  res.json({ ok: true });
});
