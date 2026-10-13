import bcrypt from 'bcryptjs';
import { Router, type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { z, type ZodTypeAny } from 'zod';
import {
  limitAuthAttempts,
  requireAdmin,
  requireAuth,
  signToken,
  type AuthUser,
} from './auth.js';
import {
  db,
  getSetting,
  newInviteCode,
  now,
  setSetting,
  uid,
  UPLOAD_DIR,
  type UserRow,
} from './db.js';
import { broadcast } from './realtime.js';

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new HttpError(400, first?.message ?? 'Données invalides.');
  }
  return result.data;
}

const me = (req: Request): AuthUser => req.user as AuthUser;

export const api = Router();

/* ------------------------------ Authentification ------------------------------ */

const registerSchema = z.object({
  name: z.string().trim().min(1, 'Le nom est obligatoire.').max(80),
  email: z.string().trim().toLowerCase().email('Adresse e-mail invalide.').max(200),
  password: z.string().min(8, 'Le mot de passe doit faire au moins 8 caractères.').max(200),
  inviteCode: z.string().trim().max(40).optional().default(''),
});

api.post('/auth/register', limitAuthAttempts, (req, res) => {
  const input = parse(registerSchema, req.body);
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
  const isFirst = n === 0;

  // Le tout premier compte devient administrateur ; les suivants ont besoin du code d'invitation.
  if (!isFirst) {
    const expected = (getSetting('invite_code') ?? '').toUpperCase();
    if (input.inviteCode.toUpperCase() !== expected) {
      throw new HttpError(403, "Code d'invitation incorrect.");
    }
  }

  const exists = db.prepare('SELECT 1 FROM users WHERE email = ?').get(input.email);
  if (exists) throw new HttpError(409, 'Cette adresse e-mail est déjà utilisée.');

  const id = uid();
  const role = isFirst ? 'admin' : 'member';
  db.prepare(
    'INSERT INTO users (id, name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, input.name, input.email, bcrypt.hashSync(input.password, 11), role, now());

  res.status(201).json({
    token: signToken(id),
    user: { id, name: input.name, email: input.email, role },
  });
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Adresse e-mail invalide.'),
  password: z.string().min(1, 'Le mot de passe est obligatoire.'),
});

api.post('/auth/login', limitAuthAttempts, (req, res) => {
  const input = parse(loginSchema, req.body);
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(input.email) as unknown as
    | UserRow
    | undefined;
  if (!row || !bcrypt.compareSync(input.password, row.password_hash)) {
    throw new HttpError(401, 'E-mail ou mot de passe incorrect.');
  }
  res.json({
    token: signToken(row.id),
    user: { id: row.id, name: row.name, email: row.email, role: row.role },
  });
});

// Permet à l'écran de connexion de savoir s'il faut créer le premier compte (admin).
api.get('/setup', (_req, res) => {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
  res.json({ hasUsers: n > 0 });
});

// Tout ce qui suit nécessite d'être connecté.
api.use(requireAuth);

api.get('/me', (req, res) => {
  res.json({ user: me(req) });
});

/* --------------------------------- Équipe --------------------------------- */

api.get('/members', (_req, res) => {
  const rows = db
    .prepare('SELECT id, name, email, role, created_at FROM users ORDER BY created_at')
    .all() as unknown as Pick<UserRow, 'id' | 'name' | 'email' | 'role' | 'created_at'>[];
  res.json({
    members: rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      role: r.role,
      createdAt: r.created_at,
    })),
  });
});

api.patch('/members/:id/role', requireAdmin, (req, res) => {
  const { role } = parse(z.object({ role: z.enum(['admin', 'member']) }), req.body);
  const id = String(req.params.id);
  const target = db.prepare('SELECT id, role FROM users WHERE id = ?').get(id) as
    | { id: string; role: string }
    | undefined;
  if (!target) throw new HttpError(404, 'Membre introuvable.');
  if (target.role === 'admin' && role === 'member') {
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as {
      n: number;
    };
    if (n <= 1) throw new HttpError(400, "Il doit rester au moins un administrateur.");
  }
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  res.json({ ok: true });
});

api.get('/invite', requireAdmin, (_req, res) => {
  res.json({ code: getSetting('invite_code') });
});

api.post('/invite/regenerate', requireAdmin, (_req, res) => {
  const code = newInviteCode();
  setSetting('invite_code', code);
  res.json({ code });
});

/* ---------------------------- Salons et messages ---------------------------- */

interface ChannelRow {
  id: string;
  name: string;
  description: string;
  admin_only: number;
}

api.get('/channels', (_req, res) => {
  const rows = db
    .prepare('SELECT id, name, description, admin_only FROM channels ORDER BY admin_only DESC, name')
    .all() as unknown as ChannelRow[];
  res.json({
    channels: rows.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      adminOnly: c.admin_only === 1,
    })),
  });
});

const channelSchema = z.object({
  name: z
    .string()
    .trim()
    .toLowerCase()
    .min(2, 'Le nom doit faire au moins 2 caractères.')
    .max(30)
    .regex(/^[\p{L}\p{N}-]+$/u, 'Lettres, chiffres et tirets uniquement.'),
  description: z.string().trim().max(200).optional().default(''),
  adminOnly: z.boolean().optional().default(false),
});

api.post('/channels', requireAdmin, (req, res) => {
  const input = parse(channelSchema, req.body);
  if (db.prepare('SELECT 1 FROM channels WHERE name = ?').get(input.name)) {
    throw new HttpError(409, 'Ce salon existe déjà.');
  }
  const id = uid();
  db.prepare(
    'INSERT INTO channels (id, name, description, admin_only, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, input.name, input.description, input.adminOnly ? 1 : 0, now());
  res.status(201).json({
    channel: { id, name: input.name, description: input.description, adminOnly: input.adminOnly },
  });
});

interface MessageJoinRow {
  id: string;
  channel_id: string;
  body: string;
  created_at: string;
  uid: string;
  uname: string;
  fid: string | null;
  fname: string | null;
  fsize: number | null;
  fmime: string | null;
}

const MESSAGE_SELECT = `
  SELECT m.id, m.channel_id, m.body, m.created_at,
         u.id AS uid, u.name AS uname,
         f.id AS fid, f.name AS fname, f.size AS fsize, f.mime AS fmime
  FROM messages m
  JOIN users u ON u.id = m.user_id
  LEFT JOIN files f ON f.id = m.file_id`;

function shapeMessage(r: MessageJoinRow) {
  return {
    id: r.id,
    channelId: r.channel_id,
    body: r.body,
    createdAt: r.created_at,
    user: { id: r.uid, name: r.uname },
    file: r.fid ? { id: r.fid, name: r.fname, size: r.fsize, mime: r.fmime } : null,
  };
}

function loadMessage(id: string) {
  const row = db.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).get(id) as unknown as MessageJoinRow;
  return shapeMessage(row);
}

function getChannel(id: string): ChannelRow {
  const channel = db
    .prepare('SELECT id, name, description, admin_only FROM channels WHERE id = ?')
    .get(id) as unknown as ChannelRow | undefined;
  if (!channel) throw new HttpError(404, 'Salon introuvable.');
  return channel;
}

api.get('/channels/:id/messages', (req, res) => {
  const channel = getChannel(String(req.params.id));
  const before = typeof req.query.before === 'string' ? req.query.before : undefined;
  const rows = (
    before
      ? db
          .prepare(
            `${MESSAGE_SELECT} WHERE m.channel_id = ? AND m.created_at < ? ORDER BY m.created_at DESC LIMIT 50`,
          )
          .all(channel.id, before)
      : db
          .prepare(`${MESSAGE_SELECT} WHERE m.channel_id = ? ORDER BY m.created_at DESC LIMIT 50`)
          .all(channel.id)
  ) as unknown as MessageJoinRow[];
  res.json({ messages: rows.reverse().map(shapeMessage), hasMore: rows.length === 50 });
});

api.post('/channels/:id/messages', (req, res) => {
  const channel = getChannel(String(req.params.id));
  const { body } = parse(
    z.object({ body: z.string().trim().min(1, 'Message vide.').max(4000, 'Message trop long.') }),
    req.body,
  );
  if (channel.admin_only === 1 && me(req).role !== 'admin') {
    throw new HttpError(403, 'Seuls les administrateurs peuvent écrire dans ce salon.');
  }
  const id = uid();
  db.prepare(
    'INSERT INTO messages (id, channel_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, channel.id, me(req).id, body, now());
  const message = loadMessage(id);
  broadcast({ type: 'message', message });
  res.status(201).json({ message });
});

/* -------------------------------- Rendez-vous -------------------------------- */

interface MeetingRow {
  id: string;
  title: string;
  description: string;
  location: string;
  starts_at: string;
  created_by: string;
  creator_name: string;
}

const MEETING_SELECT = `
  SELECT m.id, m.title, m.description, m.location, m.starts_at, m.created_by, u.name AS creator_name
  FROM meetings m JOIN users u ON u.id = m.created_by`;

function shapeMeeting(row: MeetingRow, viewerId: string) {
  const rsvps = db
    .prepare(
      `SELECT r.user_id, r.status, u.name FROM rsvps r JOIN users u ON u.id = r.user_id
       WHERE r.meeting_id = ? ORDER BY u.name`,
    )
    .all(row.id) as unknown as { user_id: string; status: 'yes' | 'maybe' | 'no'; name: string }[];
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    location: row.location,
    startsAt: row.starts_at,
    createdBy: { id: row.created_by, name: row.creator_name },
    attendees: rsvps.map((r) => ({ userId: r.user_id, name: r.name, status: r.status })),
    myStatus: rsvps.find((r) => r.user_id === viewerId)?.status ?? null,
  };
}

api.get('/meetings', (req, res) => {
  const rows = db
    .prepare(`${MEETING_SELECT} ORDER BY m.starts_at LIMIT 300`)
    .all() as unknown as MeetingRow[];
  res.json({ meetings: rows.map((r) => shapeMeeting(r, me(req).id)) });
});

const meetingSchema = z.object({
  title: z.string().trim().min(1, 'Le titre est obligatoire.').max(120),
  description: z.string().trim().max(2000).optional().default(''),
  location: z.string().trim().max(200).optional().default(''),
  startsAt: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), 'Date invalide.')
    .transform((s) => new Date(s).toISOString()),
});

api.post('/meetings', (req, res) => {
  const input = parse(meetingSchema, req.body);
  const id = uid();
  db.prepare(
    `INSERT INTO meetings (id, title, description, location, starts_at, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.title, input.description, input.location, input.startsAt, me(req).id, now());
  // Le créateur est automatiquement marqué « présent ».
  db.prepare('INSERT INTO rsvps (meeting_id, user_id, status) VALUES (?, ?, ?)').run(
    id,
    me(req).id,
    'yes',
  );
  broadcast({ type: 'meeting', meetingId: id });
  const row = db.prepare(`${MEETING_SELECT} WHERE m.id = ?`).get(id) as unknown as MeetingRow;
  res.status(201).json({ meeting: shapeMeeting(row, me(req).id) });
});

api.post('/meetings/:id/rsvp', (req, res) => {
  const { status } = parse(z.object({ status: z.enum(['yes', 'maybe', 'no']) }), req.body);
  const id = String(req.params.id);
  if (!db.prepare('SELECT 1 FROM meetings WHERE id = ?').get(id)) {
    throw new HttpError(404, 'Rendez-vous introuvable.');
  }
  db.prepare(
    `INSERT INTO rsvps (meeting_id, user_id, status) VALUES (?, ?, ?)
     ON CONFLICT(meeting_id, user_id) DO UPDATE SET status = excluded.status`,
  ).run(id, me(req).id, status);
  broadcast({ type: 'meeting', meetingId: id });
  res.json({ ok: true });
});

api.delete('/meetings/:id', (req, res) => {
  const id = String(req.params.id);
  const row = db.prepare('SELECT created_by FROM meetings WHERE id = ?').get(id) as
    | { created_by: string }
    | undefined;
  if (!row) throw new HttpError(404, 'Rendez-vous introuvable.');
  if (row.created_by !== me(req).id && me(req).role !== 'admin') {
    throw new HttpError(403, "Seul l'organisateur ou un admin peut supprimer ce rendez-vous.");
  }
  db.prepare('DELETE FROM meetings WHERE id = ?').run(id);
  broadcast({ type: 'meeting', meetingId: id });
  res.json({ ok: true });
});

/* --------------------------------- Documents --------------------------------- */

interface FileRow {
  id: string;
  name: string;
  stored_name: string;
  mime: string;
  size: number;
  folder: string;
  user_id: string;
  uploader_name: string;
  created_at: string;
}

const FILE_SELECT = `
  SELECT f.id, f.name, f.stored_name, f.mime, f.size, f.folder, f.user_id, f.created_at,
         u.name AS uploader_name
  FROM files f JOIN users u ON u.id = f.user_id`;

function shapeFile(f: FileRow) {
  return {
    id: f.id,
    name: f.name,
    size: f.size,
    mime: f.mime,
    folder: f.folder,
    createdAt: f.created_at,
    uploadedBy: { id: f.user_id, name: f.uploader_name },
  };
}

api.get('/files', (_req, res) => {
  const rows = db
    .prepare(`${FILE_SELECT} ORDER BY f.created_at DESC LIMIT 500`)
    .all() as unknown as FileRow[];
  res.json({ files: rows.map(shapeFile) });
});

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, _file, cb) => cb(null, uid()),
  }),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});

api.post(
  '/files',
  (req: Request, res: Response, next: NextFunction) => {
    upload.single('file')(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        next(
          new HttpError(
            err.code === 'LIMIT_FILE_SIZE' ? 413 : 400,
            err.code === 'LIMIT_FILE_SIZE' ? 'Fichier trop volumineux (25 Mo maximum).' : err.message,
          ),
        );
      } else if (err) next(err);
      else next();
    });
  },
  (req, res) => {
    const file = req.file;
    if (!file) throw new HttpError(400, 'Aucun fichier reçu.');

    const folder =
      z.string().trim().max(60).catch('').parse(req.body?.folder) || 'Général';
    const channelId = z.string().max(80).optional().catch(undefined).parse(req.body?.channelId);

    // multer lit les noms en latin1 : on les remet en UTF-8 (accents, etc.).
    const name = Buffer.from(file.originalname, 'latin1').toString('utf8').slice(0, 200) || 'fichier';
    const id = uid();
    try {
      db.prepare(
        `INSERT INTO files (id, name, stored_name, mime, size, folder, user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, name, file.filename, file.mimetype || 'application/octet-stream', file.size, folder, me(req).id, now());

      let message = null;
      if (channelId) {
        const channel = getChannel(channelId);
        if (channel.admin_only === 1 && me(req).role !== 'admin') {
          throw new HttpError(403, 'Seuls les administrateurs peuvent écrire dans ce salon.');
        }
        const messageId = uid();
        const caption = z.string().trim().max(4000).catch('').parse(req.body?.caption);
        db.prepare(
          'INSERT INTO messages (id, channel_id, user_id, body, file_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(messageId, channel.id, me(req).id, caption, id, now());
        message = loadMessage(messageId);
        broadcast({ type: 'message', message });
      }
      broadcast({ type: 'file', fileId: id });
      const row = db.prepare(`${FILE_SELECT} WHERE f.id = ?`).get(id) as unknown as FileRow;
      res.status(201).json({ file: shapeFile(row), message });
    } catch (e) {
      fs.rm(path.join(UPLOAD_DIR, file.filename), { force: true }, () => {});
      db.prepare('DELETE FROM files WHERE id = ?').run(id);
      throw e;
    }
  },
);

api.get('/files/:id/download', (req, res) => {
  const row = db.prepare(`${FILE_SELECT} WHERE f.id = ?`).get(String(req.params.id)) as unknown as
    | FileRow
    | undefined;
  if (!row) throw new HttpError(404, 'Fichier introuvable.');
  const filePath = path.join(UPLOAD_DIR, row.stored_name);
  if (!fs.existsSync(filePath)) throw new HttpError(404, 'Fichier introuvable sur le serveur.');
  // « attachment » : le navigateur télécharge le fichier au lieu de l'exécuter.
  res.download(filePath, row.name);
});

api.delete('/files/:id', (req, res) => {
  const id = String(req.params.id);
  const row = db.prepare('SELECT user_id, stored_name FROM files WHERE id = ?').get(id) as
    | { user_id: string; stored_name: string }
    | undefined;
  if (!row) throw new HttpError(404, 'Fichier introuvable.');
  if (row.user_id !== me(req).id && me(req).role !== 'admin') {
    throw new HttpError(403, "Seul l'auteur ou un admin peut supprimer ce fichier.");
  }
  db.prepare('DELETE FROM files WHERE id = ?').run(id);
  fs.rm(path.join(UPLOAD_DIR, row.stored_name), { force: true }, () => {});
  broadcast({ type: 'file', fileId: id });
  res.json({ ok: true });
});

/* --------------------------------- Erreurs --------------------------------- */

api.use((_req, res) => {
  res.status(404).json({ error: 'Route introuvable.' });
});

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof SyntaxError) {
    res.status(400).json({ error: 'Requête mal formée.' });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Erreur interne du serveur.' });
}
