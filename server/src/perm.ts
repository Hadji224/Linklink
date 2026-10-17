import { db, type Level, type Role } from './db.js';
import { HttpError, type AuthUser } from './http.js';

export const isStaff = (u: { role: Role }) => u.role !== 'guest';

export interface ProjectRow {
  id: string;
  name: string;
  description: string;
  color: string;
  status: 'active' | 'paused' | 'done' | 'archived';
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export function getProject(id: string): ProjectRow {
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as unknown as ProjectRow | undefined;
  if (!p) throw new HttpError(404, 'Projet introuvable.');
  return p;
}

export function isProjectMember(userId: string, projectId: string) {
  return !!db.prepare('SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?').get(projectId, userId);
}

/** Super Admin et Fondateurs voient tous les projets ; un invité seulement ceux dont il est membre. */
export function canSeeProject(user: AuthUser, projectId: string) {
  return isStaff(user) ? !!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId) : isProjectMember(user.id, projectId);
}

export function visibleProjectIds(user: AuthUser): string[] {
  const rows = (
    isStaff(user)
      ? db.prepare('SELECT id FROM projects').all()
      : db.prepare('SELECT project_id AS id FROM project_members WHERE user_id = ?').all(user.id)
  ) as { id: string }[];
  return rows.map((r) => r.id);
}

/** Lecture d'un projet (404 si invisible : on ne révèle pas son existence). */
export function projectForRead(user: AuthUser, id: string): ProjectRow {
  const p = getProject(id);
  if (!canSeeProject(user, id)) throw new HttpError(404, 'Projet introuvable.');
  return p;
}

/** Écriture dans un projet : refusée s'il est archivé. */
export function projectForWrite(user: AuthUser, id: string): ProjectRow {
  const p = projectForRead(user, id);
  if (p.status === 'archived') throw new HttpError(409, 'Ce projet est archivé : il est consultable mais non modifiable.');
  return p;
}

export interface ChannelRow {
  id: string;
  kind: 'channel' | 'project' | 'dm';
  name: string;
  description: string;
  admin_only: number;
  project_id: string | null;
  dm_a: string | null;
  dm_b: string | null;
}

export function getChannel(id: string): ChannelRow {
  const c = db.prepare('SELECT * FROM channels WHERE id = ?').get(id) as unknown as ChannelRow | undefined;
  if (!c) throw new HttpError(404, 'Salon introuvable.');
  return c;
}

const GUEST_CHANNELS = new Set(['général', 'annonces']);

export function canAccessChannel(user: AuthUser, c: ChannelRow) {
  if (c.kind === 'dm') return c.dm_a === user.id || c.dm_b === user.id;
  if (c.kind === 'project') return !!c.project_id && canSeeProject(user, c.project_id);
  return isStaff(user) || GUEST_CHANNELS.has(c.name);
}

export function channelForAccess(user: AuthUser, id: string): ChannelRow {
  const c = getChannel(id);
  if (!canAccessChannel(user, c)) throw new HttpError(404, 'Salon introuvable.');
  return c;
}

/** Peut-on écrire dans ce salon ? (annonces = Super Admin, projet archivé = non) */
export function assertCanPost(user: AuthUser, c: ChannelRow) {
  if (c.admin_only === 1 && user.role !== 'admin') {
    throw new HttpError(403, 'Seul le Super Admin peut écrire dans ce salon.');
  }
  if (c.kind === 'project' && c.project_id) projectForWrite(user, c.project_id);
}

/** Identifiants des utilisateurs qui peuvent lire un salon (pour le temps réel et les notifications). */
export function channelAudience(c: ChannelRow): string[] {
  if (c.kind === 'dm') return [c.dm_a, c.dm_b].filter(Boolean) as string[];
  const users = db.prepare('SELECT id, role FROM users').all() as { id: string; role: Role }[];
  if (c.kind === 'project' && c.project_id) {
    const members = new Set(
      (db.prepare('SELECT user_id FROM project_members WHERE project_id = ?').all(c.project_id) as { user_id: string }[]).map((r) => r.user_id),
    );
    return users.filter((u) => u.role !== 'guest' || members.has(u.id)).map((u) => u.id);
  }
  return users.filter((u) => u.role !== 'guest' || GUEST_CHANNELS.has(c.name)).map((u) => u.id);
}

export function projectAudience(projectId: string): string[] {
  const users = db.prepare('SELECT id, role FROM users').all() as { id: string; role: Role }[];
  const members = new Set(
    (db.prepare('SELECT user_id FROM project_members WHERE project_id = ?').all(projectId) as { user_id: string }[]).map((r) => r.user_id),
  );
  return users.filter((u) => u.role !== 'guest' || members.has(u.id)).map((u) => u.id);
}

export interface FileAccessRow {
  user_id: string;
  level: Level;
  channel_id: string | null;
  folder_id: string;
}

export function folderProjectId(folderId: string): string | null {
  // Remonte l'arborescence jusqu'à la racine d'un projet éventuel.
  let id: string | null = folderId;
  for (let i = 0; id && i < 50; i++) {
    const f = db.prepare('SELECT parent_id, project_id FROM folders WHERE id = ?').get(id) as
      | { parent_id: string | null; project_id: string | null }
      | undefined;
    if (!f) return null;
    if (f.project_id) return f.project_id;
    id = f.parent_id;
  }
  return null;
}

/**
 * Niveaux de confidentialité (politique de communication §9) :
 *  - public : tout le monde ;
 *  - interne : l'équipe (invités : seulement dans leurs projets) ;
 *  - confidentiel : personnes concernées (auteur, Super Admin, membres du projet) ;
 *  - strict : auteur et Super Admin uniquement.
 */
export function canViewFile(user: AuthUser, f: FileAccessRow): boolean {
  if (f.channel_id) {
    const c = db.prepare('SELECT * FROM channels WHERE id = ?').get(f.channel_id) as unknown as ChannelRow | undefined;
    return !!c && canAccessChannel(user, c);
  }
  if (user.role === 'admin' || f.user_id === user.id) return true;
  const pid = folderProjectId(f.folder_id);
  const member = pid ? isProjectMember(user.id, pid) : false;
  switch (f.level) {
    case 'public':
      return true;
    case 'internal':
      return isStaff(user) || member;
    case 'confidential':
      return member;
    default:
      return false;
  }
}

/** Dossier : lisible si on peut voir son projet ; les dossiers hors projet sont réservés à l'équipe. */
export function canSeeFolder(user: AuthUser, folderId: string): boolean {
  const pid = folderProjectId(folderId);
  if (pid) return canSeeProject(user, pid);
  const f = db.prepare('SELECT system FROM folders WHERE id = ?').get(folderId) as { system: string | null } | undefined;
  if (!f) return false;
  return isStaff(user) || f.system === 'general' ? true : false;
}
