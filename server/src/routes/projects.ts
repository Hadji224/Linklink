import { Router } from 'express';
import { z } from 'zod';
import { requireStaff } from '../auth.js';
import { actsAs, audit, can, deny, hasFn, holders, isAvailable, isOrphan, isOverdue, isProjectLead, ownFunctions, pdgIds, projectLeadOf, requireCap } from '../access.js';
import { logActivity } from '../activity.js';
import { db, now, tx, uid } from '../db.js';
import { HttpError, idParam, me, parse, type AuthUser } from '../http.js';
import { notify } from '../notify.js';
import { canSeeProject, projectAudience, projectForRead, projectForWrite, getProject, visibleProjectIds, type ProjectRow } from '../perm.js';
import { emitTo } from '../realtime.js';
import { removeStored } from '../uploads.js';

export const projectsApi = Router();

const STATUSES = ['active', 'paused', 'done', 'archived'] as const;

export function shapeProject(p: ProjectRow) {
  const t = db
    .prepare("SELECT COUNT(*) AS total, SUM(status = 'done') AS done FROM tasks WHERE project_id = ?")
    .get(p.id) as { total: number; done: number | null };
  const members = db
    .prepare('SELECT u.id, u.name, u.role FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = ? ORDER BY u.name')
    .all(p.id) as { id: string; name: string; role: string }[];
  const folder = db.prepare("SELECT id FROM folders WHERE project_id = ? AND system = 'project'").get(p.id) as { id: string } | undefined;
  const channel = db.prepare("SELECT id FROM channels WHERE project_id = ? AND kind = 'project'").get(p.id) as { id: string } | undefined;
  const done = t.done ?? 0;
  const lead = p.lead_id ? (db.prepare('SELECT id, name FROM users WHERE id = ?').get(p.lead_id) as { id: string; name: string } | undefined) : undefined;
  const pending = db.prepare("SELECT COUNT(*) AS n FROM project_proposals WHERE project_id = ? AND status = 'pending'").get(p.id) as { n: number };
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    color: p.color,
    status: p.status,
    createdBy: p.created_by,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    tasksTotal: t.total,
    tasksDone: done,
    progress: t.total ? Math.round((done / t.total) * 100) : 0, // progression automatique
    members,
    folderId: folder?.id ?? null,
    channelId: channel?.id ?? null,
    lead: lead ?? null,
    orphan: p.status !== 'archived' && isOrphan(p.id),
    doneAt: p.done_at ?? null,
    archiveMotive: p.archive_motive ?? '',
    pendingProposals: pending.n,
  };
}

/** Droits du demandeur sur ce projet (l'interface masque les boutons ; le serveur reste seul juge). */
export function projectPermissions(user: AuthUser, p: ProjectRow) {
  const lead = isProjectLead(user.id, p.id);
  const pdg = can(user, 'function.assign');
  const orphan = isOrphan(p.id);
  const coord = hasFn(user.id, 'coordinator');
  return {
    edit: (lead || pdg) && p.status !== 'archived',
    manageMembers: (lead || pdg || (coord && orphan)) && p.status !== 'archived',
    proposeMembers: coord && !orphan && !lead && !pdg && p.status !== 'archived',
    designateLead: pdg || (coord && orphan),
    proposeLead: coord && !orphan && !pdg,
    declareDone: (lead || (pdg && orphan)) && (p.status === 'active' || p.status === 'paused'),
    decideArchive: p.status === 'done' && can(user, 'project.confirm_archive'),
    reopen: pdg && (p.status === 'archived' || p.status === 'done'),
    delete: pdg,
  };
}

const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Couleur invalide.');

const createSchema = z.object({
  name: z.string().trim().min(1, 'Le nom du projet est obligatoire.').max(80),
  description: z.string().trim().max(2000).optional().default(''),
  color: colorSchema.optional().default('#135FEA'),
  memberIds: z.array(z.string()).max(60).optional().default([]),
  leadId: z.string().nullable().optional(),
});

const withPerms = (user: AuthUser, p: ProjectRow) => ({ ...shapeProject(p), permissions: projectPermissions(user, p) });
const userRow = (id: string) => db.prepare('SELECT id, name, role, suspended_at FROM users WHERE id = ?').get(id) as { id: string; name: string; role: string; suspended_at: string | null } | undefined;

/** Le responsable doit être un fondateur actif tenant la fonction « Chef de projet ». */
function assertCanLead(userId: string) {
  const u = userRow(userId);
  if (!u) throw new HttpError(404, 'Membre introuvable.');
  if (u.suspended_at || u.role === 'guest') throw new HttpError(409, 'Le responsable doit être un fondateur actif.');
  if (!ownFunctions(userId).includes('project_lead')) throw new HttpError(409, `${u.name} n'a pas la fonction « Chef de projet » : attribuez-la d'abord.`);
  return u;
}

function setLead(actor: AuthUser, p: ProjectRow, userId: string | null) {
  const before = p.lead_id;
  db.prepare('UPDATE projects SET lead_id = ?, updated_at = ? WHERE id = ?').run(userId, now(), p.id);
  if (userId) db.prepare('INSERT OR IGNORE INTO project_members (project_id,user_id) VALUES (?,?)').run(p.id, userId);
  audit(actor, 'business', 'project_lead', 'project', p.id, `Responsable du projet « ${p.name} » : ${before ? userRow(before)?.name : 'aucun'} → ${userId ? userRow(userId)?.name : 'aucun'}`);
  if (userId) notify({ userId, type: 'project', category: 'action', title: `Vous êtes responsable du projet « ${p.name} »`, link: `#projets/${p.id}` });
  if (before && before !== userId) notify({ userId: before, type: 'project', title: `Vous n'êtes plus responsable du projet « ${p.name} »`, link: `#projets/${p.id}` });
}

projectsApi.get('/projects', (req, res) => {
  const ids = visibleProjectIds(me(req));
  const q = String(req.query.q ?? '').trim().toLowerCase();
  const status = String(req.query.status ?? '');
  const rows = ids.length
    ? (db.prepare(`SELECT * FROM projects WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY updated_at DESC`).all(...ids) as unknown as ProjectRow[])
    : [];
  res.json({
    projects: rows
      .filter((p) => (!status || p.status === status) && (!q || (p.name + ' ' + p.description).toLowerCase().includes(q)))
      .map((p) => withPerms(me(req), p)),
  });
});

projectsApi.post('/projects', requireStaff, (req, res) => {
  const user = me(req);
  requireCap(user, 'project.create', 'project_create');
  const input = parse(createSchema, req.body);
  // Le Chef de projet créateur serait responsable par défaut ; ici seuls PDG et Coordinateur créent, la désignation est explicite.
  const leadId = input.leadId ?? null;
  if (leadId) assertCanLead(leadId);
  const id = uid();
  const t = now();
  tx(() => {
    db.prepare('INSERT INTO projects (id,name,description,color,status,created_by,lead_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run(
      id, input.name, input.description, input.color, 'active', user.id, leadId, t, t,
    );
    const members = new Set([user.id, ...input.memberIds, ...(leadId ? [leadId] : [])]); // le créateur devient membre
    for (const m of members) {
      if (db.prepare('SELECT 1 FROM users WHERE id = ?').get(m)) {
        db.prepare('INSERT INTO project_members (project_id,user_id) VALUES (?,?)').run(id, m);
      }
    }
    db.prepare("INSERT INTO folders (id,name,project_id,system,created_by,created_at) VALUES (?,?,?,?,?,?)").run(uid(), input.name, id, 'project', user.id, t);
    db.prepare("INSERT INTO channels (id,kind,name,description,project_id,created_at) VALUES (?,?,?,?,?,?)").run(uid(), 'project', input.name, `Discussions du projet ${input.name}`, id, t);
  });
  logActivity(user, 'create', 'project', id, `Projet « ${input.name} » créé`, id);
  audit(user, 'business', 'project_create', 'project', id, `Projet « ${input.name} » créé${leadId ? ` (responsable : ${userRow(leadId)?.name})` : ' sans responsable'}`);
  for (const m of input.memberIds) {
    if (m !== user.id) notify({ userId: m, type: 'project', title: `Vous avez été ajouté au projet « ${input.name} »`, link: `#projets/${id}` });
  }
  if (leadId && leadId !== user.id) notify({ userId: leadId, type: 'project', category: 'action', title: `Vous êtes responsable du projet « ${input.name} »`, link: `#projets/${id}` });
  if (!leadId) notify({ userId: pdgIds()[0] ?? user.id, type: 'project', category: 'action', title: `Projet sans responsable : ${input.name}`, body: 'Désignez un chef de projet.', link: `#projets/${id}`, dedupeKey: `orphan:${id}:new` });
  emitTo(projectAudience(id), { type: 'project', projectId: id });
  res.status(201).json({ project: withPerms(user, getProject(id)) });
});

projectsApi.get('/projects/:id', (req, res) => {
  res.json({ project: withPerms(me(req), projectForRead(me(req), idParam(req))) });
});

projectsApi.patch('/projects/:id', requireStaff, (req, res) => {
  const user = me(req);
  const id = idParam(req);
  const cur = projectForRead(user, id);
  const input = parse(
    z.object({
      name: z.string().trim().min(1).max(80).optional(),
      description: z.string().trim().max(2000).optional(),
      color: colorSchema.optional(),
      status: z.enum(['active', 'paused']).optional(),
    }),
    req.body,
  );
  if (cur.status === 'archived') throw new HttpError(409, 'Ce projet est archivé : le PDG peut le rouvrir (avec motif) pour le modifier.');
  if (!projectPermissions(user, cur).edit) deny(user, 'project_edit', 'Seuls le responsable du projet ou le PDG peuvent modifier ce projet.', 'project', id);
  if (cur.status === 'done' && input.status) throw new HttpError(409, "Ce projet est terminé : le PDG confirme l'archivage ou le rouvre.");
  const next = { ...cur, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) } as ProjectRow;
  tx(() => {
    db.prepare('UPDATE projects SET name=?, description=?, color=?, status=?, updated_at=? WHERE id=?').run(next.name, next.description, next.color, next.status, now(), id);
    if (next.name !== cur.name) {
      db.prepare("UPDATE channels SET name=?, description=? WHERE project_id=? AND kind='project'").run(next.name, `Discussions du projet ${next.name}`, id);
      db.prepare("UPDATE folders SET name=? WHERE project_id=? AND system='project'").run(next.name, id);
    }
  });
  if (input.status && input.status !== cur.status) {
    logActivity(user, 'status', 'project', id, `Projet « ${next.name} » : ${cur.status} → ${next.status}`, id);
    audit(user, 'business', 'project_status', 'project', id, `Projet « ${next.name} » : ${cur.status} → ${next.status}`);
  } else {
    logActivity(user, 'update', 'project', id, `Projet « ${next.name} » modifié`, id);
  }
  emitTo(projectAudience(id), { type: 'project', projectId: id });
  res.json({ project: withPerms(user, getProject(id)) });
});

/* --- Fin de projet en deux temps (§7) : le responsable déclare « terminé », le PDG confirme l'archivage. --- */

projectsApi.post('/projects/:id/done', requireStaff, (req, res) => {
  const user = me(req);
  const id = idParam(req);
  const p = projectForWrite(user, id);
  if (!projectPermissions(user, p).declareDone) {
    deny(user, 'project_done', 'Seul le responsable du projet peut le déclarer terminé (le PDG, si le projet est orphelin).', 'project', id);
  }
  const { notes } = parse(
    z.object({ notes: z.array(z.object({ taskId: z.string(), kind: z.enum(['postponed', 'cancelled']), note: z.string().trim().min(3, 'Chaque tâche ouverte doit être justifiée.').max(500) })).max(500).optional().default([]) }),
    req.body ?? {},
  );
  const open = db.prepare("SELECT id, title FROM tasks WHERE project_id = ? AND status <> 'done'").all(id) as { id: string; title: string }[];
  const missing = open.filter((t) => !notes.some((n) => n.taskId === t.id));
  if (missing.length) {
    throw new HttpError(409, `Justifiez chaque tâche ouverte (reportée ou annulée) avant de terminer : ${missing.slice(0, 5).map((t) => `« ${t.title} »`).join(', ')}${missing.length > 5 ? '…' : ''}.`);
  }
  tx(() => {
    db.prepare('DELETE FROM project_done_notes WHERE project_id = ?').run(id);
    for (const n of notes.filter((n) => open.some((t) => t.id === n.taskId))) {
      db.prepare('INSERT INTO project_done_notes (project_id,task_id,kind,note,created_at) VALUES (?,?,?,?,?)').run(id, n.taskId, n.kind, n.note, now());
    }
    db.prepare("UPDATE projects SET status='done', done_at=?, archive_motive='', updated_at=? WHERE id=?").run(now(), now(), id);
  });
  logActivity(user, 'status', 'project', id, `Projet « ${p.name} » déclaré terminé — en attente d'archivage`, id);
  audit(user, 'business', 'project_done', 'project', id, `Projet « ${p.name} » déclaré terminé (${open.length} tâche(s) ouverte(s) justifiée(s))`);
  for (const pid of pdgIds()) notify({ userId: pid, type: 'validation', category: 'action', title: `Archivage à confirmer : ${p.name}`, body: 'Le projet est terminé.', link: `#projets/${id}`, dedupeKey: `archive:${id}:${now().slice(0, 13)}` });
  emitTo(projectAudience(id), { type: 'project', projectId: id });
  res.json({ project: withPerms(user, getProject(id)) });
});

projectsApi.post('/projects/:id/archive-decision', requireStaff, (req, res) => {
  const user = me(req);
  const id = idParam(req);
  const p = getProject(id);
  if (!canSeeProject(user, id)) throw new HttpError(404, 'Projet introuvable.');
  if (p.status !== 'done') throw new HttpError(409, "Seul un projet « Terminé — en attente d'archivage » peut être archivé ou refusé.");
  const a = actsAs(user.id, 'pdg', 'archive', isOverdue('archive', p.done_at));
  if (!a.ok) deny(user, 'project_archive_decide', "Seul le PDG (ou son mandataire de remplacement) confirme l'archivage.", 'project', id);
  const { decision, motive } = parse(z.object({ decision: z.enum(['approve', 'refuse']), motive: z.string().trim().max(500).optional().default('') }), req.body);
  if (decision === 'refuse' && motive.length < 3) throw new HttpError(400, "Un refus d'archivage doit être motivé : le projet repasse « Actif » avec le motif.");
  if (decision === 'approve') db.prepare("UPDATE projects SET status='archived', archive_motive='', updated_at=? WHERE id=?").run(now(), id);
  else db.prepare("UPDATE projects SET status='active', done_at=NULL, archive_motive=?, updated_at=? WHERE id=?").run(motive, now(), id);
  audit(user, 'business', decision === 'approve' ? 'project_archive' : 'project_archive_refused', 'project', id, `Archivage du projet « ${p.name} » ${decision === 'approve' ? 'confirmé' : 'refusé'}`, { details: motive, mandateId: a.mandateId });
  logActivity(user, 'status', 'project', id, `Projet « ${p.name} » : ${decision === 'approve' ? 'archivé' : 'archivage refusé — retour à Actif'}`, id);
  if (p.lead_id) notify({ userId: p.lead_id, type: 'project', category: decision === 'approve' ? 'info' : 'action', title: decision === 'approve' ? `Projet archivé : ${p.name}` : `Archivage refusé : ${p.name}`, body: motive, link: `#projets/${id}` });
  emitTo(projectAudience(id), { type: 'project', projectId: id });
  res.json({ project: withPerms(user, getProject(id)) });
});

projectsApi.post('/projects/:id/reopen', requireStaff, (req, res) => {
  const user = me(req);
  const id = idParam(req);
  const p = projectForRead(user, id);
  requireCap(user, 'project.reopen', 'project_reopen', 'project', id);
  if (p.status !== 'archived' && p.status !== 'done') throw new HttpError(409, "Ce projet n'est ni terminé ni archivé.");
  const { motive } = parse(z.object({ motive: z.string().trim().min(5, 'Le motif de réouverture est obligatoire.').max(500) }), req.body);
  db.prepare("UPDATE projects SET status='active', done_at=NULL, updated_at=? WHERE id=?").run(now(), id);
  audit(user, 'business', 'project_reopen', 'project', id, `Projet « ${p.name} » rouvert`, { details: motive });
  logActivity(user, 'status', 'project', id, `Projet « ${p.name} » rouvert : ${motive}`, id);
  if (p.lead_id) notify({ userId: p.lead_id, type: 'project', category: 'action', title: `Projet rouvert : ${p.name}`, body: motive, link: `#projets/${id}` });
  emitTo(projectAudience(id), { type: 'project', projectId: id });
  res.json({ project: withPerms(user, getProject(id)) });
});

projectsApi.delete('/projects/:id', requireStaff, (req, res) => {
  const user = me(req);
  const id = idParam(req);
  const p = getProject(id);
  requireCap(user, 'project.delete', 'project_delete', 'project', id);
  const linked = (db.prepare('SELECT (SELECT COUNT(*) FROM expenses WHERE project_id = ?) AS e, (SELECT COUNT(*) FROM communications WHERE project_id = ?) AS c').get(id, id)) as { e: number; c: number };
  if (linked.e || linked.c) {
    throw new HttpError(409, `Ce projet est lié à ${linked.e} dépense(s) et ${linked.c} communication(s) : il ne peut qu'être archivé (la traçabilité financière et éditoriale est conservée).`);
  }
  const stored = (
    db
      .prepare(
        `WITH RECURSIVE tree(id) AS (
           SELECT id FROM folders WHERE project_id = ?
           UNION ALL SELECT f.id FROM folders f JOIN tree t ON f.parent_id = t.id)
         SELECT stored_name FROM files WHERE folder_id IN (SELECT id FROM tree)`,
      )
      .all(id) as { stored_name: string }[]
  ).map((r) => r.stored_name);
  const audience = projectAudience(id);
  logActivity(user, 'delete', 'project', id, `Projet « ${p.name} » supprimé`);
  audit(user, 'business', 'project_delete', 'project', id, `Projet « ${p.name} » supprimé`);
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  removeStored(stored);
  emitTo(audience, { type: 'project', projectId: id });
  res.json({ ok: true });
});

/* --- Responsable et membres : direct pour le responsable / le PDG, par proposition pour le Coordinateur. --- */

projectsApi.put('/projects/:id/lead', requireStaff, (req, res) => {
  const user = me(req);
  const id = idParam(req);
  const p = projectForWrite(user, id);
  const { userId } = parse(z.object({ userId: z.string().nullable() }), req.body);
  const perms = projectPermissions(user, p);
  if (userId) assertCanLead(userId);
  if (perms.designateLead) {
    setLead(user, p, userId);
    // Les propositions de désignation en attente sont closes.
    db.prepare("UPDATE project_proposals SET status='accepted', decided_by=?, decided_at=? WHERE project_id=? AND action='set_lead' AND status='pending'").run(user.id, now(), id);
  } else if (perms.proposeLead && userId) {
    const pid = uid();
    db.prepare("INSERT INTO project_proposals (id,project_id,action,target_user_id,proposed_by,created_at) VALUES (?,?,?,?,?,?)").run(pid, id, 'set_lead', userId, user.id, now());
    audit(user, 'business', 'project_proposal', 'project', id, `Proposition : ${userRow(userId)?.name} responsable de « ${p.name} »`);
    for (const x of pdgIds()) notify({ userId: x, type: 'validation', category: 'action', title: `Proposition à décider : responsable de « ${p.name} »`, body: `${user.name} propose ${userRow(userId)?.name}.`, link: `#projets/${id}` });
    return res.status(202).json({ proposal: pid, project: withPerms(user, getProject(id)) });
  } else {
    deny(user, 'project_lead_set', 'Seul le PDG désigne le responsable (le Coordinateur le fait directement pour un projet orphelin, sinon il propose).', 'project', id);
  }
  emitTo(projectAudience(id), { type: 'project', projectId: id });
  res.json({ project: withPerms(user, getProject(id)) });
});

projectsApi.get('/projects/:id/proposals', requireStaff, (req, res) => {
  const id = idParam(req);
  projectForRead(me(req), id);
  const rows = db.prepare("SELECT * FROM project_proposals WHERE project_id = ? ORDER BY created_at DESC LIMIT 50").all(id) as { id: string; action: string; target_user_id: string; proposed_by: string | null; status: string; motive: string; created_at: string }[];
  res.json({ proposals: rows.map((r) => ({ id: r.id, action: r.action, target: { id: r.target_user_id, name: userRow(r.target_user_id)?.name ?? '—' }, proposedBy: r.proposed_by ? (userRow(r.proposed_by)?.name ?? '—') : '—', status: r.status, motive: r.motive, createdAt: r.created_at })) });
});

projectsApi.post('/projects/:id/proposals/:pid/decision', requireStaff, (req, res) => {
  const user = me(req);
  const id = idParam(req);
  const p = projectForWrite(user, id);
  if (!can(user, 'function.assign')) deny(user, 'project_proposal_decide', 'Seul le PDG décide des propositions du Coordinateur.', 'project', id);
  const { decision, motive } = parse(z.object({ decision: z.enum(['accept', 'refuse']), motive: z.string().trim().max(500).optional().default('') }), req.body);
  const prop = db.prepare("SELECT * FROM project_proposals WHERE id = ? AND project_id = ?").get(idParam(req, 'pid'), id) as { id: string; action: 'add_member' | 'remove_member' | 'set_lead'; target_user_id: string; proposed_by: string | null; status: string } | undefined;
  if (!prop) throw new HttpError(404, 'Proposition introuvable.');
  if (prop.status !== 'pending') throw new HttpError(409, 'Cette proposition a déjà été traitée.');
  if (decision === 'refuse' && motive.length < 3) throw new HttpError(400, 'Un refus doit être motivé.');
  if (decision === 'accept') {
    if (prop.action === 'set_lead') {
      assertCanLead(prop.target_user_id);
      setLead(user, p, prop.target_user_id);
    } else if (prop.action === 'add_member') db.prepare('INSERT OR IGNORE INTO project_members (project_id,user_id) VALUES (?,?)').run(id, prop.target_user_id);
    else db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(id, prop.target_user_id);
  }
  db.prepare('UPDATE project_proposals SET status=?, decided_by=?, motive=?, decided_at=? WHERE id=?').run(decision === 'accept' ? 'accepted' : 'refused', user.id, motive, now(), prop.id);
  audit(user, 'business', `project_proposal_${decision}`, 'project', id, `Proposition (${prop.action}) sur « ${p.name} » ${decision === 'accept' ? 'acceptée' : 'refusée'}`, { details: motive });
  if (prop.proposed_by) notify({ userId: prop.proposed_by, type: 'project', title: `Proposition ${decision === 'accept' ? 'acceptée' : 'refusée'} : ${p.name}`, body: motive, link: `#projets/${id}` });
  emitTo(projectAudience(id), { type: 'project', projectId: id });
  res.json({ project: withPerms(user, getProject(id)) });
});

projectsApi.post('/projects/:id/members', requireStaff, (req, res) => {
  const user = me(req);
  const id = idParam(req);
  const p = projectForWrite(user, id);
  const { userId } = parse(z.object({ userId: z.string() }), req.body);
  const u = db.prepare('SELECT id, name FROM users WHERE id = ?').get(userId) as { id: string; name: string } | undefined;
  if (!u) throw new HttpError(404, 'Membre introuvable.');
  const perms = projectPermissions(user, p);
  if (!perms.manageMembers) {
    if (perms.proposeMembers) {
      const pid = uid();
      db.prepare("INSERT INTO project_proposals (id,project_id,action,target_user_id,proposed_by,created_at) VALUES (?,?,?,?,?,?)").run(pid, id, 'add_member', userId, user.id, now());
      audit(user, 'business', 'project_proposal', 'project', id, `Proposition : ajouter ${u.name} à « ${p.name} »`);
      for (const x of new Set([...pdgIds(), ...(p.lead_id ? [p.lead_id] : [])])) notify({ userId: x, type: 'validation', category: 'action', title: `Proposition : ajouter ${u.name} à « ${p.name} »`, body: `Proposé par ${user.name}.`, link: `#projets/${id}` });
      return res.status(202).json({ proposal: pid, project: withPerms(user, getProject(id)) });
    }
    deny(user, 'project_member_add', "Seuls le responsable du projet ou le PDG ajoutent des membres (le Coordinateur propose).", 'project', id);
  }
  db.prepare('INSERT OR IGNORE INTO project_members (project_id,user_id) VALUES (?,?)').run(id, userId);
  logActivity(user, 'member', 'project', id, `${u.name} ajouté au projet « ${p.name} »`, id);
  audit(user, 'business', 'project_member_add', 'project', id, `${u.name} ajouté au projet « ${p.name} »`);
  if (userId !== user.id) notify({ userId, type: 'project', title: `Vous avez été ajouté au projet « ${p.name} »`, link: `#projets/${id}` });
  emitTo(projectAudience(id), { type: 'project', projectId: id });
  res.json({ project: withPerms(user, getProject(id)) });
});

projectsApi.delete('/projects/:id/members/:userId', requireStaff, (req, res) => {
  const user = me(req);
  const id = idParam(req);
  const p = projectForWrite(user, id);
  const userId = idParam(req, 'userId');
  const u = db.prepare('SELECT name FROM users WHERE id = ?').get(userId) as { name: string } | undefined;
  const perms = projectPermissions(user, p);
  if (userId === p.lead_id) throw new HttpError(409, 'Le responsable ne peut pas être retiré : désignez d\'abord un autre responsable.');
  if (!perms.manageMembers) {
    if (perms.proposeMembers) {
      const pid = uid();
      db.prepare("INSERT INTO project_proposals (id,project_id,action,target_user_id,proposed_by,created_at) VALUES (?,?,?,?,?,?)").run(pid, id, 'remove_member', userId, user.id, now());
      audit(user, 'business', 'project_proposal', 'project', id, `Proposition : retirer ${u?.name ?? 'un membre'} de « ${p.name} »`);
      for (const x of new Set([...pdgIds(), ...(p.lead_id ? [p.lead_id] : [])])) notify({ userId: x, type: 'validation', category: 'action', title: `Proposition : retirer ${u?.name ?? 'un membre'} de « ${p.name} »`, body: `Proposé par ${user.name}.`, link: `#projets/${id}` });
      return res.status(202).json({ proposal: pid, project: withPerms(user, getProject(id)) });
    }
    deny(user, 'project_member_remove', 'Seuls le responsable du projet ou le PDG retirent des membres (le Coordinateur propose).', 'project', id);
  }
  const before = projectAudience(id);
  db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(id, userId);
  logActivity(user, 'member', 'project', id, `${u?.name ?? 'Un membre'} retiré du projet « ${p.name} »`, id);
  audit(user, 'business', 'project_member_remove', 'project', id, `${u?.name ?? 'Un membre'} retiré du projet « ${p.name} »`);
  emitTo(before, { type: 'project', projectId: id });
  res.json({ project: withPerms(user, getProject(id)) });
});

projectsApi.get('/projects/:id/activity', (req, res) => {
  const id = idParam(req);
  projectForRead(me(req), id);
  const rows = db
    .prepare('SELECT id, user_name, action, summary, created_at FROM activity_log WHERE project_id = ? ORDER BY created_at DESC LIMIT 100')
    .all(id) as { id: string; user_name: string; action: string; summary: string; created_at: string }[];
  res.json({ activity: rows.map((r) => ({ id: r.id, userName: r.user_name, action: r.action, summary: r.summary, createdAt: r.created_at })) });
});
