import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { requireStaff } from '../auth.js';
import { logActivity } from '../activity.js';
import { db, now, tx, uid, UPLOAD_DIR, type Level } from '../db.js';
import { HttpError, idParam, me, parse } from '../http.js';
import { canSeeFolder, canViewFile, channelForAccess, folderProjectId, assertCanPost, projectForWrite, projectAudience, canSeeProject, isStaff } from '../perm.js';
import { emitAll, emitTo } from '../realtime.js';
import { cleanName, mimeFor, PREVIEWABLE, receiveFile, removeStored } from '../uploads.js';
import { postMessage } from './channels.js';

export const filesApi = Router();

const LEVELS = ['public', 'internal', 'confidential', 'strict'] as const;

interface FileRow {
  id: string; name: string; stored_name: string; mime: string; size: number; folder_id: string;
  channel_id: string | null; task_id: string | null; level: Level; user_id: string; uploader_name: string; created_at: string;
}
const FILE_SELECT = `SELECT f.*, u.name AS uploader_name FROM files f JOIN users u ON u.id = f.user_id`;

function shapeFile(f: FileRow) {
  return {
    id: f.id,
    name: f.name,
    size: f.size,
    mime: f.mime,
    folderId: f.folder_id,
    level: f.level,
    taskId: f.task_id,
    previewable: PREVIEWABLE.has(f.mime),
    createdAt: f.created_at,
    uploadedBy: { id: f.user_id, name: f.uploader_name },
  };
}

const loadFile = (id: string) => db.prepare(`${FILE_SELECT} WHERE f.id = ?`).get(id) as unknown as FileRow | undefined;

function fileForRead(req: Parameters<typeof me>[0], id: string): FileRow {
  const f = loadFile(id);
  if (!f || !canViewFile(me(req), f)) throw new HttpError(404, 'Fichier introuvable.');
  return f;
}

/** Peut-on déposer dans ce dossier ? (lecture + projet non archivé) */
function folderForWrite(req: Parameters<typeof me>[0], id: string) {
  const f = db.prepare('SELECT * FROM folders WHERE id = ?').get(id) as unknown as
    | { id: string; name: string; parent_id: string | null; project_id: string | null; system: string | null; created_by: string | null }
    | undefined;
  if (!f || !canSeeFolder(me(req), id)) throw new HttpError(404, 'Dossier introuvable.');
  const pid = folderProjectId(id);
  if (pid) projectForWrite(me(req), pid);
  else if (f.system === 'messages') throw new HttpError(400, 'Le dossier « Messages » est rempli automatiquement par les pièces jointes des salons.');
  return f;
}

/* ------------------------------- Dossiers ------------------------------- */

function folderCounts() {
  const rows = db.prepare('SELECT folder_id, COUNT(*) AS n FROM files GROUP BY folder_id').all() as { folder_id: string; n: number }[];
  return new Map(rows.map((r) => [r.folder_id, r.n]));
}

filesApi.get('/folders', (req, res) => {
  const rows = db.prepare('SELECT * FROM folders ORDER BY system IS NULL, name').all() as unknown as {
    id: string; name: string; parent_id: string | null; project_id: string | null; system: string | null; created_at: string;
  }[];
  const counts = folderCounts();
  const user = me(req);
  const visible = rows.filter((f) => canSeeFolder(user, f.id));
  // Pour un invité, le dossier « Messages » n'a pas de sens ; pour tous, on ne montre que ce qui est lisible.
  res.json({
    folders: visible.map((f) => ({
      id: f.id, name: f.name, parentId: f.parent_id, projectId: f.project_id, system: f.system, fileCount: counts.get(f.id) ?? 0,
    })),
  });
});

filesApi.post('/folders', (req, res) => {
  const { name, parentId } = parse(
    z.object({ name: z.string().trim().min(1, 'Le nom est obligatoire.').max(60).regex(/^[^/\\]+$/, 'Le nom ne peut pas contenir / ou \\.'), parentId: z.string().nullable().optional() }),
    req.body,
  );
  if (!parentId && !isStaff(me(req))) throw new HttpError(403, 'Choisissez un dossier parent.');
  if (parentId) folderForWrite(req, parentId);
  const dup = db.prepare('SELECT 1 FROM folders WHERE name = ? AND parent_id IS ?').get(name, parentId ?? null);
  if (dup) throw new HttpError(409, 'Un dossier porte déjà ce nom ici.');
  const id = uid();
  db.prepare('INSERT INTO folders (id,name,parent_id,created_by,created_at) VALUES (?,?,?,?,?)').run(id, name, parentId ?? null, me(req).id, now());
  const pid = parentId ? folderProjectId(parentId) : null;
  logActivity(me(req), 'create', 'folder', id, `Dossier « ${name} » créé`, pid);
  emitAll({ type: 'file' });
  res.status(201).json({ folder: { id, name, parentId: parentId ?? null, projectId: null, system: null, fileCount: 0 } });
});

filesApi.patch('/folders/:id', requireStaff, (req, res) => {
  const f = folderForWrite(req, idParam(req));
  if (f.system) throw new HttpError(400, 'Ce dossier système ne peut pas être renommé.');
  const { name } = parse(z.object({ name: z.string().trim().min(1).max(60).regex(/^[^/\\]+$/) }), req.body);
  db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(name, f.id);
  emitAll({ type: 'file' });
  res.json({ ok: true });
});

filesApi.delete('/folders/:id', requireStaff, (req, res) => {
  const f = folderForWrite(req, idParam(req));
  if (f.system) throw new HttpError(400, 'Ce dossier système ne peut pas être supprimé.');
  if (f.created_by !== me(req).id && me(req).role !== 'admin') throw new HttpError(403, "Seul l'auteur du dossier ou le Super Admin peut le supprimer.");
  const rows = db
    .prepare(
      `WITH RECURSIVE tree(id) AS (SELECT id FROM folders WHERE id = ? UNION ALL SELECT c.id FROM folders c JOIN tree t ON c.parent_id = t.id)
       SELECT f.stored_name, f.user_id FROM files f WHERE f.folder_id IN (SELECT id FROM tree)`,
    )
    .all(f.id) as { stored_name: string; user_id: string }[];
  // Un fondateur ne peut pas détruire, par ce biais, les fichiers des autres.
  if (me(req).role !== 'admin' && rows.some((r) => r.user_id !== me(req).id)) {
    throw new HttpError(403, 'Ce dossier contient des fichiers déposés par d\'autres personnes.');
  }
  db.prepare('DELETE FROM folders WHERE id = ?').run(f.id);
  removeStored(rows.map((r) => r.stored_name));
  logActivity(me(req), 'delete', 'folder', f.id, `Dossier « ${f.name} » supprimé`, folderProjectId(f.parent_id ?? '') ?? null);
  emitAll({ type: 'file' });
  res.json({ ok: true });
});

/* -------------------------------- Fichiers -------------------------------- */

filesApi.get('/files', (req, res) => {
  const { folderId, q, author, from, to, level } = req.query as Record<string, string | undefined>;
  const where: string[] = ['f.channel_id IS NULL'];
  const args: string[] = [];
  if (folderId) { where.push('f.folder_id = ?'); args.push(folderId); }
  if (q) { where.push('f.name LIKE ?'); args.push(`%${q}%`); }
  if (author) { where.push('f.user_id = ?'); args.push(author); }
  if (from) { where.push('f.created_at >= ?'); args.push(from); }
  if (to) { where.push('f.created_at <= ?'); args.push(`${to}T23:59:59.999Z`); }
  if (level && (LEVELS as readonly string[]).includes(level)) { where.push('f.level = ?'); args.push(level); }
  // Les pièces jointes de salons restent dans le dossier « Messages » (visibles selon l'accès au salon).
  const isMessagesFolder = folderId && (db.prepare("SELECT 1 FROM folders WHERE id = ? AND system = 'messages'").get(folderId) ?? false);
  const sql = isMessagesFolder
    ? `${FILE_SELECT} WHERE f.folder_id = ? ORDER BY f.created_at DESC LIMIT 500`
    : `${FILE_SELECT} WHERE ${where.join(' AND ')} ORDER BY f.created_at DESC LIMIT 1000`;
  const rows = db.prepare(sql).all(...(isMessagesFolder ? [folderId as string] : args)) as unknown as FileRow[];
  const visible = rows.filter((f) => canViewFile(me(req), f)).slice(0, 300);
  res.json({ files: visible.map(shapeFile) });
});

filesApi.post('/files', receiveFile, (req, res) => {
  const file = req.file;
  if (!file) throw new HttpError(400, 'Aucun fichier reçu.');
  const body = req.body ?? {};
  const name = cleanName(file.originalname);
  const mime = mimeFor(name) as string;
  const level = parse(z.enum(LEVELS).catch('internal'), body.level);
  const channelId = z.string().max(80).optional().catch(undefined).parse(body.channelId);
  const taskId = z.string().max(80).optional().catch(undefined).parse(body.taskId);
  const id = uid();
  try {
    let folderId: string;
    let chanId: string | null = null;
    let linkedTask: string | null = null;
    let projectId: string | null = null;
    if (channelId) {
      const channel = channelForAccess(me(req), channelId);
      assertCanPost(me(req), channel);
      folderId = (db.prepare("SELECT id FROM folders WHERE system = 'messages'").get() as { id: string }).id;
      chanId = channel.id;
      projectId = channel.project_id;
    } else if (taskId) {
      const t = db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(taskId) as { project_id: string } | undefined;
      if (!t || !canSeeProject(me(req), t.project_id)) throw new HttpError(404, 'Tâche introuvable.');
      projectForWrite(me(req), t.project_id);
      folderId = (db.prepare("SELECT id FROM folders WHERE project_id = ? AND system = 'project'").get(t.project_id) as { id: string }).id;
      linkedTask = taskId;
      projectId = t.project_id;
    } else {
      const target = z.string().max(80).optional().catch(undefined).parse(body.folderId) ?? (db.prepare("SELECT id FROM folders WHERE system = 'general'").get() as { id: string }).id;
      folderId = folderForWrite(req, target).id;
      projectId = folderProjectId(folderId);
    }
    db.prepare('INSERT INTO files (id,name,stored_name,mime,size,folder_id,channel_id,task_id,level,user_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
      id, name, file.filename, mime, file.size, folderId, chanId, linkedTask, level, me(req).id, now(),
    );
    let message = null;
    if (chanId) {
      const caption = z.string().trim().max(4000).catch('').parse(body.caption);
      message = postMessage(channelForAccess(me(req), chanId), me(req), caption, id);
    }
    logActivity(me(req), 'upload', 'file', id, `Fichier « ${name} » déposé`, projectId);
    if (projectId) emitTo(projectAudience(projectId), { type: 'file', fileId: id });
    else emitAll({ type: 'file', fileId: id });
    res.status(201).json({ file: shapeFile(loadFile(id) as FileRow), message });
  } catch (e) {
    fs.rm(path.join(UPLOAD_DIR, file.filename), { force: true }, () => {});
    db.prepare('DELETE FROM files WHERE id = ?').run(id);
    throw e;
  }
});

filesApi.patch('/files/:id', (req, res) => {
  const f = fileForRead(req, idParam(req));
  if (f.user_id !== me(req).id && me(req).role !== 'admin') throw new HttpError(403, "Seul l'auteur ou le Super Admin peut modifier ce fichier.");
  const input = parse(
    z.object({
      level: z.enum(LEVELS).optional(),
      folderId: z.string().optional(),
      name: z.string().trim().min(1).max(200).regex(/^[^/\\]+$/).optional(),
    }),
    req.body,
  );
  let folderId = f.folder_id;
  if (input.folderId && !f.channel_id) folderId = folderForWrite(req, input.folderId).id;
  let name = f.name;
  if (input.name) {
    if (!mimeFor(input.name) || mimeFor(input.name) !== f.mime) throw new HttpError(400, "L'extension du fichier ne peut pas être changée.");
    name = input.name;
  }
  db.prepare('UPDATE files SET level = ?, folder_id = ?, name = ? WHERE id = ?').run(input.level ?? f.level, folderId, name, f.id);
  emitAll({ type: 'file', fileId: f.id });
  res.json({ file: shapeFile(loadFile(f.id) as FileRow) });
});

filesApi.get('/files/:id/download', (req, res) => {
  const f = fileForRead(req, idParam(req));
  const p = path.join(UPLOAD_DIR, f.stored_name);
  if (!fs.existsSync(p)) throw new HttpError(404, 'Fichier introuvable sur le serveur.');
  if (f.level === 'confidential' || f.level === 'strict') {
    logActivity(me(req), 'download', 'file', f.id, `Fichier ${f.level === 'strict' ? 'strictement confidentiel' : 'confidentiel'} « ${f.name} » téléchargé`, folderProjectId(f.folder_id));
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.download(p, f.name); // « attachment » : jamais exécuté par le navigateur
});

// Aperçu : uniquement des images, type MIME imposé par le serveur, dans un bac à sable.
filesApi.get('/files/:id/preview', (req, res) => {
  const f = fileForRead(req, idParam(req));
  if (!PREVIEWABLE.has(f.mime)) throw new HttpError(415, 'Aperçu indisponible pour ce type de fichier.');
  const p = path.join(UPLOAD_DIR, f.stored_name);
  if (!fs.existsSync(p)) throw new HttpError(404, 'Fichier introuvable sur le serveur.');
  res.setHeader('Content-Type', f.mime);
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=300');
  fs.createReadStream(p).pipe(res);
});

// Matrice v1.1 : chacun supprime ses propres fichiers (y compris ses pièces jointes de tâche) ; le Super Admin supprime tout.
filesApi.delete('/files/:id', (req, res) => {
  const f = fileForRead(req, idParam(req));
  const user = me(req);
  if (!(user.role === 'admin' || f.user_id === user.id)) {
    throw new HttpError(403, 'Vous ne pouvez supprimer que vos propres fichiers.');
  }
  const projectId = folderProjectId(f.folder_id);
  if (projectId) projectForWrite(user, projectId);
  tx(() => db.prepare('DELETE FROM files WHERE id = ?').run(f.id));
  removeStored([f.stored_name]);
  logActivity(user, 'delete', 'file', f.id, `Fichier « ${f.name} » supprimé`, projectId);
  emitAll({ type: 'file', fileId: f.id });
  res.json({ ok: true });
});
