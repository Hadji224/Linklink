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
import { mapA } from "../async.js";

export const projectsApi = Router();

const STATUSES = ['active', 'paused', 'done', 'archived'] as const;

export async function shapeProject(p: ProjectRow) {
  const t = await db
      .prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done FROM tasks WHERE project_id = ?")
      .get(p.id) as { total: number; done: number | null };
  const members = await db
      .prepare('SELECT u.id, u.name, u.role FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = ? ORDER BY u.name')
      .all(p.id) as { id: string; name: string; role: string }[];
  const folder = await db.prepare("SELECT id FROM folders WHERE project_id = ? AND system = 'project'").get(p.id) as { id: string } | undefined;
  const channel = await db.prepare("SELECT id FROM channels WHERE project_id = ? AND kind = 'project'").get(p.id) as { id: string } | undefined;
  const done = t.done ?? 0;
  const lead = p.lead_id ? (await db.prepare('SELECT id, name FROM users WHERE id = ?').get(p.lead_id) as { id: string; name: string } | undefined) : undefined;
  const pending = await db.prepare("SELECT COUNT(*) AS n FROM project_proposals WHERE project_id = ? AND status = 'pending'").get(p.id) as { n: number };
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
    orphan: p.status !== 'archived' && (await isOrphan(p.id)),
    doneAt: p.done_at ?? null,
    archiveMotive: p.archive_motive ?? '',
    pendingProposals: pending.n,
  };
}

/** Droits du demandeur sur ce projet (l'interface masque les boutons ; le serveur reste seul juge). */
export async function projectPermissions(user: AuthUser, p: ProjectRow) {
  const lead = await isProjectLead(user.id, p.id);
  const pdg = await can(user, 'function.assign');
  const orphan = await isOrphan(p.id);
  const coord = await hasFn(user.id, 'coordinator');
  return {
    edit: (lead || pdg) && p.status !== 'archived',
    manageMembers: (lead || pdg || (coord && orphan)) && p.status !== 'archived',
    proposeMembers: coord && !orphan && !lead && !pdg && p.status !== 'archived',
    designateLead: pdg || (coord && orphan),
    proposeLead: coord && !orphan && !pdg,
    declareDone: (lead || (pdg && orphan)) && (p.status === 'active' || p.status === 'paused'),
    decideArchive: p.status === 'done' && (await can(user, 'project.confirm_archive')),
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

const withPerms = async (user: AuthUser, p: ProjectRow) => ({ ...(await shapeProject(p)), permissions: (await projectPermissions(user, p)) });
const userRow = async (id: string) => await db.prepare('SELECT id, name, role, suspended_at FROM users WHERE id = ?').get(id) as { id: string; name: string; role: string; suspended_at: string | null } | undefined;

/** Le responsable doit être un fondateur actif tenant la fonction « Chef de projet ». */
async function assertCanLead(userId: string) {
  const u = await userRow(userId);
  if (!u) throw new HttpError(404, 'Membre introuvable.');
  if (u.suspended_at || u.role === 'guest') throw new HttpError(409, 'Le responsable doit être un fondateur actif.');
  if (!(await ownFunctions(userId)).includes('project_lead')) throw new HttpError(409, `${u.name} n'a pas la fonction « Chef de projet » : attribuez-la d'abord.`);
  return u;
}

async function setLead(actor: AuthUser, p: ProjectRow, userId: string | null) {
  const before = p.lead_id;
  await db.prepare('UPDATE projects SET lead_id = ?, updated_at = ? WHERE id = ?').run(userId, now(), p.id);
  if (userId) await db.prepare('INSERT OR IGNORE INTO project_members (project_id,user_id) VALUES (?,?)').run(p.id, userId);
  await audit(actor, 'business', 'project_lead', 'project', p.id, `Responsable du projet « ${p.name} » : ${before ? (await userRow(before))?.name : 'aucun'} → ${userId ? (await userRow(userId))?.name : 'aucun'}`);
  if (userId) await notify({ userId, type: 'project', category: 'action', title: `Vous êtes responsable du projet « ${p.name} »`, link: `#projets/${p.id}` });
  if (before && before !== userId) await notify({ userId: before, type: 'project', title: `Vous n'êtes plus responsable du projet « ${p.name} »`, link: `#projets/${p.id}` });
}

projectsApi.get('/projects', async (req, res) => {
  const ids = await visibleProjectIds(me(req));
  const q = String(req.query.q ?? '').trim().toLowerCase();
  const status = String(req.query.status ?? '');
  const rows = ids.length
    ? (await db.prepare(`SELECT * FROM projects WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY updated_at DESC`).all(...ids) as unknown as ProjectRow[])
    : [];
  res.json({
    projects: (await mapA(rows
            .filter((p) => (!status || p.status === status) && (!q || (p.name + ' ' + p.description).toLowerCase().includes(q))), async (p) => await withPerms(me(req), p))),
  });
});

projectsApi.post('/projects', requireStaff, async (req, res) => {
  const user = me(req);
  await requireCap(user, 'project.create', 'project_create');
  const input = parse(createSchema, req.body);
  // Le Chef de projet créateur serait responsable par défaut ; ici seuls PDG et Coordinateur créent, la désignation est explicite.
  const leadId = input.leadId ?? null;
  if (leadId) await assertCanLead(leadId);
  const id = uid();
  const t = now();
  await tx(async () => {
        await db.prepare('INSERT INTO projects (id,name,description,color,status,created_by,lead_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run(
                id, input.name, input.description, input.color, 'active', user.id, leadId, t, t,
              );
        const members = new Set([user.id, ...input.memberIds, ...(leadId ? [leadId] : [])]); // le créateur devient membre
        for (const m of members) {
          if ((await db.prepare('SELECT 1 FROM users WHERE id = ?').get(m))) {
            await db.prepare('INSERT INTO project_members (project_id,user_id) VALUES (?,?)').run(id, m);
          }
        }
        await db.prepare("INSERT INTO folders (id,name,project_id,system,created_by,created_at) VALUES (?,?,?,?,?,?)").run(uid(), input.name, id, 'project', user.id, t);
        await db.prepare("INSERT INTO channels (id,kind,name,description,project_id,created_at) VALUES (?,?,?,?,?,?)").run(uid(), 'project', input.name, `Discussions du projet ${input.name}`, id, t);
      });
  await logActivity(user, 'create', 'project', id, `Projet « ${input.name} » créé`, id);
  await audit(user, 'business', 'project_create', 'project', id, `Projet « ${input.name} » créé${leadId ? ` (responsable : ${(await userRow(leadId))?.name})` : ' sans responsable'}`);
  for (const m of input.memberIds) {
    if (m !== user.id) await notify({ userId: m, type: 'project', title: `Vous avez été ajouté au projet « ${input.name} »`, link: `#projets/${id}` });
  }
  if (leadId && leadId !== user.id) await notify({ userId: leadId, type: 'project', category: 'action', title: `Vous êtes responsable du projet « ${input.name} »`, link: `#projets/${id}` });
  if (!leadId) await notify({ userId: (await pdgIds())[0] ?? user.id, type: 'project', category: 'action', title: `Projet sans responsable : ${input.name}`, body: 'Désignez un chef de projet.', link: `#projets/${id}`, dedupeKey: `orphan:${id}:new` });
  emitTo((await projectAudience(id)), { type: 'project', projectId: id });
  res.status(201).json({ project: (await withPerms(user, (await getProject(id)))) });
});

projectsApi.get('/projects/:id', async (req, res) => {
  res.json({ project: (await withPerms(me(req), (await projectForRead(me(req), idParam(req))))) });
});

projectsApi.patch('/projects/:id', requireStaff, async (req, res) => {
  const user = me(req);
  const id = idParam(req);
  const cur = await projectForRead(user, id);
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
  if (!(await projectPermissions(user, cur)).edit) throw await deny(user, 'project_edit', 'Seuls le responsable du projet ou le PDG peuvent modifier ce projet.', 'project', id);
  if (cur.status === 'done' && input.status) throw new HttpError(409, "Ce projet est terminé : le PDG confirme l'archivage ou le rouvre.");
  const next = { ...cur, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) } as ProjectRow;
  await tx(async () => {
        await db.prepare('UPDATE projects SET name=?, description=?, color=?, status=?, updated_at=? WHERE id=?').run(next.name, next.description, next.color, next.status, now(), id);
        if (next.name !== cur.name) {
          await db.prepare("UPDATE channels SET name=?, description=? WHERE project_id=? AND kind='project'").run(next.name, `Discussions du projet ${next.name}`, id);
          await db.prepare("UPDATE folders SET name=? WHERE project_id=? AND system='project'").run(next.name, id);
        }
      });
  if (input.status && input.status !== cur.status) {
    await logActivity(user, 'status', 'project', id, `Projet « ${next.name} » : ${cur.status} → ${next.status}`, id);
    await audit(user, 'business', 'project_status', 'project', id, `Projet « ${next.name} » : ${cur.status} → ${next.status}`);
  } else {
    await logActivity(user, 'update', 'project', id, `Projet « ${next.name} » modifié`, id);
  }
  emitTo((await projectAudience(id)), { type: 'project', projectId: id });
  res.json({ project: (await withPerms(user, (await getProject(id)))) });
});

/* --- Fin de projet en deux temps (§7) : le responsable déclare « terminé », le PDG confirme l'archivage. --- */

projectsApi.post('/projects/:id/done', requireStaff, async (req, res) => {
  const user = me(req);
  const id = idParam(req);
  const p = await projectForWrite(user, id);
  if (!(await projectPermissions(user, p)).declareDone) {
    throw await deny(user, 'project_done', 'Seul le responsable du projet peut le déclarer terminé (le PDG, si le projet est orphelin).', 'project', id);
  }
  const { notes } = parse(
    z.object({ notes: z.array(z.object({ taskId: z.string(), kind: z.enum(['postponed', 'cancelled']), note: z.string().trim().min(3, 'Chaque tâche ouverte doit être justifiée.').max(500) })).max(500).optional().default([]) }),
    req.body ?? {},
  );
  const open = await db.prepare("SELECT id, title FROM tasks WHERE project_id = ? AND status <> 'done'").all(id) as { id: string; title: string }[];
  const missing = open.filter((t) => !notes.some((n) => n.taskId === t.id));
  if (missing.length) {
    throw new HttpError(409, `Justifiez chaque tâche ouverte (reportée ou annulée) avant de terminer : ${missing.slice(0, 5).map((t) => `« ${t.title} »`).join(', ')}${missing.length > 5 ? '…' : ''}.`);
  }
  await tx(async () => {
        await db.prepare('DELETE FROM project_done_notes WHERE project_id = ?').run(id);
        for (const n of notes.filter((n) => open.some((t) => t.id === n.taskId))) {
          await db.prepare('INSERT INTO project_done_notes (project_id,task_id,kind,note,created_at) VALUES (?,?,?,?,?)').run(id, n.taskId, n.kind, n.note, now());
        }
        await db.prepare("UPDATE projects SET status='done', done_at=?, archive_motive='', updated_at=? WHERE id=?").run(now(), now(), id);
      });
  await logActivity(user, 'status', 'project', id, `Projet « ${p.name} » déclaré terminé — en attente d'archivage`, id);
  await audit(user, 'business', 'project_done', 'project', id, `Projet « ${p.name} » déclaré terminé (${open.length} tâche(s) ouverte(s) justifiée(s))`);
  for (const pid of (await pdgIds())) await notify({ userId: pid, type: 'validation', category: 'action', title: `Archivage à confirmer : ${p.name}`, body: 'Le projet est terminé.', link: `#projets/${id}`, dedupeKey: `archive:${id}:${now().slice(0, 13)}` });
  emitTo((await projectAudience(id)), { type: 'project', projectId: id });
  res.json({ project: (await withPerms(user, (await getProject(id)))) });
});

projectsApi.post('/projects/:id/archive-decision', requireStaff, async (req, res) => {
  const user = me(req);
  const id = idParam(req);
  const p = await getProject(id);
  if (!(await canSeeProject(user, id))) throw new HttpError(404, 'Projet introuvable.');
  if (p.status !== 'done') throw new HttpError(409, "Seul un projet « Terminé — en attente d'archivage » peut être archivé ou refusé.");
  const a = await actsAs(user.id, 'pdg', 'archive', (await isOverdue('archive', p.done_at)));
  if (!a.ok) throw await deny(user, 'project_archive_decide', "Seul le PDG (ou son mandataire de remplacement) confirme l'archivage.", 'project', id);
  const { decision, motive } = parse(z.object({ decision: z.enum(['approve', 'refuse']), motive: z.string().trim().max(500).optional().default('') }), req.body);
  if (decision === 'refuse' && motive.length < 3) throw new HttpError(400, "Un refus d'archivage doit être motivé : le projet repasse « Actif » avec le motif.");
  if (decision === 'approve') await db.prepare("UPDATE projects SET status='archived', archive_motive='', updated_at=? WHERE id=?").run(now(), id);
  else await db.prepare("UPDATE projects SET status='active', done_at=NULL, archive_motive=?, updated_at=? WHERE id=?").run(motive, now(), id);
  await audit(user, 'business', decision === 'approve' ? 'project_archive' : 'project_archive_refused', 'project', id, `Archivage du projet « ${p.name} » ${decision === 'approve' ? 'confirmé' : 'refusé'}`, { details: motive, mandateId: a.mandateId });
  await logActivity(user, 'status', 'project', id, `Projet « ${p.name} » : ${decision === 'approve' ? 'archivé' : 'archivage refusé — retour à Actif'}`, id);
  if (p.lead_id) await notify({ userId: p.lead_id, type: 'project', category: decision === 'approve' ? 'info' : 'action', title: decision === 'approve' ? `Projet archivé : ${p.name}` : `Archivage refusé : ${p.name}`, body: motive, link: `#projets/${id}` });
  emitTo((await projectAudience(id)), { type: 'project', projectId: id });
  res.json({ project: (await withPerms(user, (await getProject(id)))) });
});

projectsApi.post('/projects/:id/reopen', requireStaff, async (req, res) => {
  const user = me(req);
  const id = idParam(req);
  const p = await projectForRead(user, id);
  await requireCap(user, 'project.reopen', 'project_reopen', 'project', id);
  if (p.status !== 'archived' && p.status !== 'done') throw new HttpError(409, "Ce projet n'est ni terminé ni archivé.");
  const { motive } = parse(z.object({ motive: z.string().trim().min(5, 'Le motif de réouverture est obligatoire.').max(500) }), req.body);
  await db.prepare("UPDATE projects SET status='active', done_at=NULL, updated_at=? WHERE id=?").run(now(), id);
  await audit(user, 'business', 'project_reopen', 'project', id, `Projet « ${p.name} » rouvert`, { details: motive });
  await logActivity(user, 'status', 'project', id, `Projet « ${p.name} » rouvert : ${motive}`, id);
  if (p.lead_id) await notify({ userId: p.lead_id, type: 'project', category: 'action', title: `Projet rouvert : ${p.name}`, body: motive, link: `#projets/${id}` });
  emitTo((await projectAudience(id)), { type: 'project', projectId: id });
  res.json({ project: (await withPerms(user, (await getProject(id)))) });
});

projectsApi.delete('/projects/:id', requireStaff, async (req, res) => {
  const user = me(req);
  const id = idParam(req);
  const p = await getProject(id);
  await requireCap(user, 'project.delete', 'project_delete', 'project', id);
  const linked = (await db.prepare('SELECT (SELECT COUNT(*) FROM expenses WHERE project_id = ?) AS e, (SELECT COUNT(*) FROM communications WHERE project_id = ?) AS c').get(id, id)) as { e: number; c: number };
  if (linked.e || linked.c) {
    throw new HttpError(409, `Ce projet est lié à ${linked.e} dépense(s) et ${linked.c} communication(s) : il ne peut qu'être archivé (la traçabilité financière et éditoriale est conservée).`);
  }
  const stored = (
    await db
            .prepare(
              `WITH RECURSIVE tree(id) AS (
           SELECT id FROM folders WHERE project_id = ?
           UNION ALL SELECT f.id FROM folders f JOIN tree t ON f.parent_id = t.id)
         SELECT stored_name FROM files WHERE folder_id IN (SELECT id FROM tree)`,
            )
            .all(id) as { stored_name: string }[]
  ).map((r) => r.stored_name);
  const audience = await projectAudience(id);
  await logActivity(user, 'delete', 'project', id, `Projet « ${p.name} » supprimé`);
  await audit(user, 'business', 'project_delete', 'project', id, `Projet « ${p.name} » supprimé`);
  await db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  removeStored(stored);
  emitTo(audience, { type: 'project', projectId: id });
  res.json({ ok: true });
});

/* --- Responsable et membres : direct pour le responsable / le PDG, par proposition pour le Coordinateur. --- */

projectsApi.put('/projects/:id/lead', requireStaff, async (req, res) => {
  const user = me(req);
  const id = idParam(req);
  const p = await projectForWrite(user, id);
  const { userId } = parse(z.object({ userId: z.string().nullable() }), req.body);
  const perms = await projectPermissions(user, p);
  if (userId) await assertCanLead(userId);
  if (perms.designateLead) {
    await setLead(user, p, userId);
    // Les propositions de désignation en attente sont closes.
    await db.prepare("UPDATE project_proposals SET status='accepted', decided_by=?, decided_at=? WHERE project_id=? AND action='set_lead' AND status='pending'").run(user.id, now(), id);
  } else if (perms.proposeLead && userId) {
    const pid = uid();
    await db.prepare("INSERT INTO project_proposals (id,project_id,action,target_user_id,proposed_by,created_at) VALUES (?,?,?,?,?,?)").run(pid, id, 'set_lead', userId, user.id, now());
    await audit(user, 'business', 'project_proposal', 'project', id, `Proposition : ${(await userRow(userId))?.name} responsable de « ${p.name} »`);
    for (const x of (await pdgIds())) await notify({ userId: x, type: 'validation', category: 'action', title: `Proposition à décider : responsable de « ${p.name} »`, body: `${user.name} propose ${(await userRow(userId))?.name}.`, link: `#projets/${id}` });
    return res.status(202).json({ proposal: pid, project: (await withPerms(user, (await getProject(id)))) });
  } else {
    throw await deny(user, 'project_lead_set', 'Seul le PDG désigne le responsable (le Coordinateur le fait directement pour un projet orphelin, sinon il propose).', 'project', id);
  }
  emitTo((await projectAudience(id)), { type: 'project', projectId: id });
  res.json({ project: (await withPerms(user, (await getProject(id)))) });
});

projectsApi.get('/projects/:id/proposals', requireStaff, async (req, res) => {
  const id = idParam(req);
  await projectForRead(me(req), id);
  const rows = await db.prepare("SELECT * FROM project_proposals WHERE project_id = ? ORDER BY created_at DESC LIMIT 50").all(id) as { id: string; action: string; target_user_id: string; proposed_by: string | null; status: string; motive: string; created_at: string }[];
  res.json({ proposals: (await mapA(rows, async (r) => ({ id: r.id, action: r.action, target: { id: r.target_user_id, name: (await userRow(r.target_user_id))?.name ?? '—' }, proposedBy: r.proposed_by ? ((await userRow(r.proposed_by))?.name ?? '—') : '—', status: r.status, motive: r.motive, createdAt: r.created_at }))) });
});

projectsApi.post('/projects/:id/proposals/:pid/decision', requireStaff, async (req, res) => {
  const user = me(req);
  const id = idParam(req);
  const p = await projectForWrite(user, id);
  if (!(await can(user, 'function.assign'))) throw await deny(user, 'project_proposal_decide', 'Seul le PDG décide des propositions du Coordinateur.', 'project', id);
  const { decision, motive } = parse(z.object({ decision: z.enum(['accept', 'refuse']), motive: z.string().trim().max(500).optional().default('') }), req.body);
  const prop = await db.prepare("SELECT * FROM project_proposals WHERE id = ? AND project_id = ?").get(idParam(req, 'pid'), id) as { id: string; action: 'add_member' | 'remove_member' | 'set_lead'; target_user_id: string; proposed_by: string | null; status: string } | undefined;
  if (!prop) throw new HttpError(404, 'Proposition introuvable.');
  if (prop.status !== 'pending') throw new HttpError(409, 'Cette proposition a déjà été traitée.');
  if (decision === 'refuse' && motive.length < 3) throw new HttpError(400, 'Un refus doit être motivé.');
  if (decision === 'accept') {
    if (prop.action === 'set_lead') {
      await assertCanLead(prop.target_user_id);
      await setLead(user, p, prop.target_user_id);
    } else if (prop.action === 'add_member') await db.prepare('INSERT OR IGNORE INTO project_members (project_id,user_id) VALUES (?,?)').run(id, prop.target_user_id);
    else await db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(id, prop.target_user_id);
  }
  await db.prepare('UPDATE project_proposals SET status=?, decided_by=?, motive=?, decided_at=? WHERE id=?').run(decision === 'accept' ? 'accepted' : 'refused', user.id, motive, now(), prop.id);
  await audit(user, 'business', `project_proposal_${decision}`, 'project', id, `Proposition (${prop.action}) sur « ${p.name} » ${decision === 'accept' ? 'acceptée' : 'refusée'}`, { details: motive });
  if (prop.proposed_by) await notify({ userId: prop.proposed_by, type: 'project', title: `Proposition ${decision === 'accept' ? 'acceptée' : 'refusée'} : ${p.name}`, body: motive, link: `#projets/${id}` });
  emitTo((await projectAudience(id)), { type: 'project', projectId: id });
  res.json({ project: (await withPerms(user, (await getProject(id)))) });
});

projectsApi.post('/projects/:id/members', requireStaff, async (req, res) => {
  const user = me(req);
  const id = idParam(req);
  const p = await projectForWrite(user, id);
  const { userId } = parse(z.object({ userId: z.string() }), req.body);
  const u = await db.prepare('SELECT id, name FROM users WHERE id = ?').get(userId) as { id: string; name: string } | undefined;
  if (!u) throw new HttpError(404, 'Membre introuvable.');
  const perms = await projectPermissions(user, p);
  if (!perms.manageMembers) {
    if (perms.proposeMembers) {
      const pid = uid();
      await db.prepare("INSERT INTO project_proposals (id,project_id,action,target_user_id,proposed_by,created_at) VALUES (?,?,?,?,?,?)").run(pid, id, 'add_member', userId, user.id, now());
      await audit(user, 'business', 'project_proposal', 'project', id, `Proposition : ajouter ${u.name} à « ${p.name} »`);
      for (const x of new Set([...(await pdgIds()), ...(p.lead_id ? [p.lead_id] : [])])) await notify({ userId: x, type: 'validation', category: 'action', title: `Proposition : ajouter ${u.name} à « ${p.name} »`, body: `Proposé par ${user.name}.`, link: `#projets/${id}` });
      return res.status(202).json({ proposal: pid, project: (await withPerms(user, (await getProject(id)))) });
    }
    throw await deny(user, 'project_member_add', "Seuls le responsable du projet ou le PDG ajoutent des membres (le Coordinateur propose).", 'project', id);
  }
  await db.prepare('INSERT OR IGNORE INTO project_members (project_id,user_id) VALUES (?,?)').run(id, userId);
  await logActivity(user, 'member', 'project', id, `${u.name} ajouté au projet « ${p.name} »`, id);
  await audit(user, 'business', 'project_member_add', 'project', id, `${u.name} ajouté au projet « ${p.name} »`);
  if (userId !== user.id) await notify({ userId, type: 'project', title: `Vous avez été ajouté au projet « ${p.name} »`, link: `#projets/${id}` });
  emitTo((await projectAudience(id)), { type: 'project', projectId: id });
  res.json({ project: (await withPerms(user, (await getProject(id)))) });
});

projectsApi.delete('/projects/:id/members/:userId', requireStaff, async (req, res) => {
  const user = me(req);
  const id = idParam(req);
  const p = await projectForWrite(user, id);
  const userId = idParam(req, 'userId');
  const u = await db.prepare('SELECT name FROM users WHERE id = ?').get(userId) as { name: string } | undefined;
  const perms = await projectPermissions(user, p);
  if (userId === p.lead_id) throw new HttpError(409, 'Le responsable ne peut pas être retiré : désignez d\'abord un autre responsable.');
  if (!perms.manageMembers) {
    if (perms.proposeMembers) {
      const pid = uid();
      await db.prepare("INSERT INTO project_proposals (id,project_id,action,target_user_id,proposed_by,created_at) VALUES (?,?,?,?,?,?)").run(pid, id, 'remove_member', userId, user.id, now());
      await audit(user, 'business', 'project_proposal', 'project', id, `Proposition : retirer ${u?.name ?? 'un membre'} de « ${p.name} »`);
      for (const x of new Set([...(await pdgIds()), ...(p.lead_id ? [p.lead_id] : [])])) await notify({ userId: x, type: 'validation', category: 'action', title: `Proposition : retirer ${u?.name ?? 'un membre'} de « ${p.name} »`, body: `Proposé par ${user.name}.`, link: `#projets/${id}` });
      return res.status(202).json({ proposal: pid, project: (await withPerms(user, (await getProject(id)))) });
    }
    throw await deny(user, 'project_member_remove', 'Seuls le responsable du projet ou le PDG retirent des membres (le Coordinateur propose).', 'project', id);
  }
  const before = await projectAudience(id);
  await db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(id, userId);
  await logActivity(user, 'member', 'project', id, `${u?.name ?? 'Un membre'} retiré du projet « ${p.name} »`, id);
  await audit(user, 'business', 'project_member_remove', 'project', id, `${u?.name ?? 'Un membre'} retiré du projet « ${p.name} »`);
  emitTo(before, { type: 'project', projectId: id });
  res.json({ project: (await withPerms(user, (await getProject(id)))) });
});

projectsApi.get('/projects/:id/activity', async (req, res) => {
  const id = idParam(req);
  await projectForRead(me(req), id);
  const rows = await db
      .prepare('SELECT id, user_name, action, summary, created_at FROM activity_log WHERE project_id = ? ORDER BY created_at DESC LIMIT 100')
      .all(id) as { id: string; user_name: string; action: string; summary: string; created_at: string }[];
  res.json({ activity: rows.map((r) => ({ id: r.id, userName: r.user_name, action: r.action, summary: r.summary, createdAt: r.created_at })) });
});
