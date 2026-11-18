import { Router } from 'express';
import { z } from 'zod';
import { audit, can, deny, holders, pdgIds, requireCap } from '../access.js';
import { blockedSlots, getComm, KIND_FR, openSlots, slotFor, slotsOf, SLOT_FR, snapshotVersion, validationsOf, type CommRow } from '../comms.js';
import { db, now, tx, uid } from '../db.js';
import { HttpError, idParam, me, parse, type AuthUser } from '../http.js';
import { notify } from '../notify.js';
import { canSeeProject, getChannel } from '../perm.js';
import { postMessage } from './channels.js';
import { mapA } from "../async.js";

export const communicationsApi = Router();

/** Publie le contenu dans le salon #annonces (le message porte le nom de l'auteur de la publication). */
async function announce(user: AuthUser, c: CommRow, icon: string) {
  const ch = await db.prepare("SELECT id FROM channels WHERE kind = 'channel' AND name = 'annonces'").get() as { id: string } | undefined;
  if (!ch) return;
  await postMessage((await getChannel(ch.id)), user, `${icon} ${c.title}\n${c.body}`);
}

/** Notifie toute l'équipe (invités compris : une publication est un contenu de l'équipe). */
async function notifyTeam(title: string, c: CommRow, exceptId: string, category: 'info' | 'action' | 'urgent' = 'info') {
  const users = await db.prepare("SELECT id FROM users WHERE suspended_at IS NULL AND role <> 'guest'").all() as { id: string }[];
  for (const u of users) {
    if (u.id === exceptId) continue;
    await notify({ userId: u.id, type: 'communication', category, title, body: c.body.slice(0, 120), link: '#communications', dedupeKey: `pub:${c.id}:${c.status}:${u.id}` });
  }
}

export async function shapeComm(c: CommRow, user: AuthUser, detail = false) {
  const open = c.status === 'in_validation' ? (await openSlots(c)) : [];
  const mine = c.status === 'in_validation' ? (await slotFor(user.id, c)) : null;
  const isAuthor = c.author_id === user.id;
  const base = {
    id: c.id, family: c.family, kind: c.kind, kindLabel: KIND_FR[c.kind], title: c.title, body: c.body, status: c.status, version: c.version, crisis: c.crisis === 1,
    author: { id: c.author_id, name: c.author_name }, projectId: c.project_id,
    projectName: c.project_id ? ((await db.prepare('SELECT name FROM projects WHERE id = ?').get(c.project_id) as { name: string } | undefined)?.name ?? null) : null,
    circuit: slotsOf(c).map((s) => SLOT_FR[s]),
    openSlots: open.map((s) => SLOT_FR[s]),
    blocked: (await blockedSlots(c)).map((s) => SLOT_FR[s]),
    reviewDueAt: c.review_due_at, reviewedAt: c.reviewed_at, reviewNote: c.review_note, decisionMotive: c.decision_motive,
    publishedAt: c.published_at, createdAt: c.created_at, updatedAt: c.updated_at,
    permissions: {
      edit: isAuthor && ['draft', 'in_validation', 'validated', 'refused'].includes(c.status) && c.family === 'official',
      submit: isAuthor && (c.status === 'draft' || c.status === 'refused'),
      validate: !!mine && !('error' in mine),
      publish: c.status === 'validated' && (await can(user, 'comm.publish')),
      withdraw: c.status === 'published' && (await can(user, 'comm.withdraw')),
      review: c.crisis === 1 && c.status === 'published' && !c.reviewed_at && (await pdgIds()).includes(user.id),
    },
    validateHint: mine && 'error' in mine ? mine.error : null,
  };
  if (!detail) return base;
  return {
    ...base,
    validations: (await validationsOf(c.id)).map((v) => ({ version: v.version, slot: SLOT_FR[v.slot], by: v.validator_name, decision: v.decision, motive: v.motive, mandate: !!v.mandate_id, createdAt: v.created_at, current: v.version === c.version })),
    versions: (await db.prepare('SELECT version, title, body, created_at FROM communication_versions WHERE comm_id = ? ORDER BY version').all(c.id)),
  };
}

function visibleTo(user: AuthUser, c: CommRow): boolean {
  if (user.role === 'guest') return c.status === 'published' && c.family === 'internal' && false;
  return true;
}

communicationsApi.get('/communications', async (req, res) => {
  const user = me(req);
  if (user.role === 'guest') throw new HttpError(403, 'Les communications sont réservées à l\'équipe.');
  const rows = await db.prepare('SELECT * FROM communications ORDER BY updated_at DESC LIMIT 300').all() as unknown as CommRow[];
  res.json({ communications: (await mapA(rows.filter((c) => visibleTo(user, c)), async (c) => await shapeComm(c, user))) });
});

communicationsApi.get('/communications/:id', async (req, res) => {
  const user = me(req);
  if (user.role === 'guest') throw new HttpError(403, 'Les communications sont réservées à l\'équipe.');
  res.json({ communication: (await shapeComm((await getComm(idParam(req))), user, true)) });
});

const draftSchema = z.object({
  kind: z.enum(['current', 'project', 'official', 'technical', 'paid_ad']),
  title: z.string().trim().min(1, 'Le titre est obligatoire.').max(150),
  body: z.string().trim().min(1, 'Le contenu est obligatoire.').max(4000),
  projectId: z.string().nullable().optional(),
  submit: z.boolean().optional().default(false),
});

async function submit(user: AuthUser, c: CommRow) {
  await tx(async () => {
        await snapshotVersion(c);
        await db.prepare("UPDATE communications SET status='in_validation', submitted_at=?, updated_at=? WHERE id=?").run(now(), now(), c.id);
      });
  const fresh = await getComm(c.id);
  await audit(user, 'business', 'comm_submit', 'communication', c.id, `Communication soumise à validation : « ${c.title} » (${KIND_FR[c.kind]})`);
  const users = await db.prepare("SELECT id FROM users WHERE suspended_at IS NULL AND role <> 'guest'").all() as { id: string }[];
  for (const u of users) {
    if (u.id === user.id) continue;
    const s = await slotFor(u.id, fresh);
    if (!('error' in s)) await notify({ userId: u.id, type: 'validation', category: 'action', title: `Contenu à valider : ${c.title}`, body: `${KIND_FR[c.kind]} — étape « ${SLOT_FR[s.slot]} »`, link: '#communications', dedupeKey: `comm:${c.id}:${c.version}` });
  }
  return fresh;
}

communicationsApi.post('/communications', async (req, res) => {
  const user = me(req);
  await requireCap(user, 'comm.prepare', 'comm_create', 'communication');
  const input = parse(draftSchema, req.body);
  if (input.kind === 'project') {
    if (!input.projectId || !(await canSeeProject(user, input.projectId))) throw new HttpError(400, 'Un contenu lié à un projet doit désigner un projet.');
  }
  const id = uid();
  const t = now();
  await db.prepare(
        `INSERT INTO communications (id,author_id,author_name,family,kind,title,body,project_id,status,version,created_at,updated_at) VALUES (?,?,?,'official',?,?,?,?,'draft',1,?,?)`,
      ).run(id, user.id, user.name, input.kind, input.title, input.body, input.kind === 'project' ? input.projectId! : null, t, t);
  await audit(user, 'business', 'comm_create', 'communication', id, `Brouillon créé : « ${input.title} » (${KIND_FR[input.kind]})`);
  const c = input.submit ? (await submit(user, (await getComm(id)))) : (await getComm(id));
  res.status(201).json({ communication: (await shapeComm(c, user, true)) });
});

communicationsApi.post('/communications/:id/submit', async (req, res) => {
  const user = me(req);
  const c = await getComm(idParam(req));
  if (c.author_id !== user.id) throw await deny(user, 'comm_submit', 'Seul l\'auteur peut soumettre son contenu.', 'communication', c.id);
  if (c.status === 'refused') await db.prepare("UPDATE communications SET version=version+1, status='draft', updated_at=? WHERE id=?").run(now(), c.id);
  else if (c.status !== 'draft') throw new HttpError(409, 'Ce contenu est déjà soumis.');
  res.json({ communication: (await shapeComm((await submit(user, (await getComm(c.id)))), user, true)) });
});

// Modification : toute modification après validation invalide les validations (§8.5) → nouvelle version « En validation ».
communicationsApi.patch('/communications/:id', async (req, res) => {
  const user = me(req);
  const c = await getComm(idParam(req));
  if (c.author_id !== user.id) throw await deny(user, 'comm_edit', "Seul l'auteur peut modifier son contenu.", 'communication', c.id);
  if (c.family !== 'official' || !['draft', 'in_validation', 'validated', 'refused'].includes(c.status)) throw new HttpError(409, 'Ce contenu ne peut plus être modifié (publié ou retiré).');
  const input = parse(z.object({ title: z.string().trim().min(1).max(150).optional(), body: z.string().trim().min(1).max(4000).optional() }), req.body);
  const title = input.title ?? c.title, body = input.body ?? c.body;
  if (title === c.title && body === c.body) return void res.json({ communication: (await shapeComm(c, user, true)) });
  if (c.status === 'draft') {
    await db.prepare('UPDATE communications SET title=?, body=?, updated_at=? WHERE id=?').run(title, body, now(), c.id);
  } else if (c.status === 'refused') {
    await db.prepare("UPDATE communications SET title=?, body=?, version=version+1, status='draft', updated_at=? WHERE id=?").run(title, body, now(), c.id);
  } else {
    // En validation ou validé : nouvelle version, retour en validation, anciennes validations conservées mais sans effet.
    await db.prepare("UPDATE communications SET title=?, body=?, version=version+1, status='in_validation', submitted_at=?, updated_at=? WHERE id=?").run(title, body, now(), now(), c.id);
    await snapshotVersion((await getComm(c.id)));
    await audit(user, 'business', 'comm_modified', 'communication', c.id, `Contenu modifié après validation : nouvelle version, validations invalidées (« ${title} »)`);
  }
  res.json({ communication: (await shapeComm((await getComm(c.id)), user, true)) });
});

communicationsApi.post('/communications/:id/validate', async (req, res) => {
  const user = me(req);
  const c = await getComm(idParam(req));
  const input = parse(z.object({ decision: z.enum(['approve', 'refuse']), motive: z.string().trim().max(500).optional().default('') }), req.body);
  if (c.status !== 'in_validation') throw new HttpError(409, "Ce contenu n'est pas en validation.");
  const mine = await slotFor(user.id, c);
  if ('error' in mine) throw await deny(user, 'comm_validate', mine.error, 'communication', c.id);
  if (input.decision === 'refuse' && input.motive.length < 3) throw new HttpError(400, 'Le motif du refus est obligatoire.');
  await db.prepare('INSERT INTO communication_validations (id,comm_id,version,slot,validator_id,validator_name,decision,motive,mandate_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(
        uid(), c.id, c.version, mine.slot, user.id, user.name, input.decision, input.motive, mine.mandateId, now(),
      );
  if (input.decision === 'refuse') {
    await db.prepare("UPDATE communications SET status='refused', decision_motive=?, updated_at=? WHERE id=?").run(input.motive, now(), c.id);
    await audit(user, 'business', 'comm_refuse', 'communication', c.id, `Contenu refusé (${SLOT_FR[mine.slot]}) : ${input.motive}`, { mandateId: mine.mandateId });
    if (c.author_id) await notify({ userId: c.author_id, type: 'communication', category: 'action', title: `Contenu refusé : ${c.title}`, body: input.motive, link: '#communications' });
  } else {
    await audit(user, 'business', 'comm_validate', 'communication', c.id, `Validation (${SLOT_FR[mine.slot]}) de « ${c.title} », version ${c.version}`, { mandateId: mine.mandateId });
    const fresh = await getComm(c.id);
    if (!(await openSlots(fresh)).length) {
      await db.prepare("UPDATE communications SET status='validated', updated_at=? WHERE id=?").run(now(), c.id);
      for (const h of (await holders('comms'))) await notify({ userId: h.id, type: 'communication', category: 'action', title: `Prêt à publier : ${c.title}`, body: 'Toutes les validations sont obtenues.', link: '#communications' });
    }
  }
  res.json({ communication: (await shapeComm((await getComm(c.id)), user, true)) });
});

communicationsApi.post('/communications/:id/publish', async (req, res) => {
  const user = me(req);
  const c = await getComm(idParam(req));
  await requireCap(user, 'comm.publish', 'comm_publish', 'communication', c.id);
  if (c.status !== 'validated') throw await deny(user, 'comm_publish', 'Publication impossible sans toutes les validations.', 'communication', c.id);
  await db.prepare("UPDATE communications SET status='published', published_at=?, published_by=?, updated_at=? WHERE id=?").run(now(), user.id, now(), c.id);
  await audit(user, 'business', 'comm_publish', 'communication', c.id, `Communication publiée : « ${c.title} » (${KIND_FR[c.kind]})`);
  await announce(user, c, '📣');
  await notifyTeam(`Communication publiée : ${c.title}`, c, user.id);
  res.json({ communication: (await shapeComm((await getComm(c.id)), user, true)) });
});

// Annonce interne (#annonces) : le PDG ou le Chargé de communication publie directement ; avis de service : administrateur technique / Chef d'infrastructures mandaté.
communicationsApi.post('/announcements', async (req, res) => {
  const user = me(req);
  const input = parse(z.object({ title: z.string().trim().min(1, 'Le titre est obligatoire.').max(150), body: z.string().trim().min(1).max(4000), service: z.boolean().optional().default(false) }), req.body);
  await requireCap(user, input.service ? 'announce.service' : 'announce.internal', input.service ? 'announce_service' : 'announce_internal', 'communication');
  const id = uid();
  const t = now();
  await db.prepare(
        `INSERT INTO communications (id,author_id,author_name,family,kind,title,body,status,version,published_at,published_by,created_at,updated_at) VALUES (?,?,?,'internal',?,?,?,'published',1,?,?,?,?)`,
      ).run(id, user.id, user.name, input.service ? 'service' : 'announcement', input.title, input.body, t, user.id, t, t);
  const c = await getComm(id);
  await audit(user, input.service ? 'security' : 'business', input.service ? 'service_notice' : 'announce', 'communication', id, `${input.service ? 'Avis de service' : 'Annonce interne'} publié : « ${input.title} »`);
  await announce(user, c, input.service ? '🛠️' : '📣');
  await notifyTeam(`${input.service ? 'Avis de service' : 'Annonce'} : ${input.title}`, c, user.id, input.service ? 'urgent' : 'info');
  res.status(201).json({ communication: (await shapeComm(c, user, true)) });
});

// Communication de crise (§8.3) : voie rapide du PDG, ou du Chargé de communication avec mandat de porte-parole ; revue sous 24 h.
communicationsApi.post('/communications/crisis', async (req, res) => {
  const user = me(req);
  const input = parse(z.object({ title: z.string().trim().min(1, 'Le titre est obligatoire.').max(150), body: z.string().trim().min(1).max(4000) }), req.body);
  await requireCap(user, 'crisis.publish', 'crisis_publish', 'communication');
  const id = uid();
  const t = now();
  await db.prepare(
        `INSERT INTO communications (id,author_id,author_name,family,kind,title,body,status,version,crisis,review_due_at,published_at,published_by,created_at,updated_at) VALUES (?,?,?,'official','crisis',?,?,'published',1,1,?,?,?,?,?)`,
      ).run(id, user.id, user.name, input.title, input.body, new Date(Date.now() + 24 * 3600_000).toISOString(), t, user.id, t, t);
  const c = await getComm(id);
  await snapshotVersion(c);
  await audit(user, 'business', 'crisis_publish', 'communication', id, `COMMUNICATION DE CRISE publiée : « ${input.title} » (revue sous 24 h)`);
  await announce(user, c, '🚨');
  await notifyTeam(`Communication de crise : ${input.title}`, c, user.id, 'urgent');
  if (!(await pdgIds()).includes(user.id)) for (const p of (await pdgIds())) await notify({ userId: p, type: 'communication', category: 'urgent', title: `Revue demandée sous 24 h : ${input.title}`, body: `Publiée par ${user.name}`, link: '#communications' });
  res.status(201).json({ communication: (await shapeComm(c, user, true)) });
});

communicationsApi.post('/communications/:id/review', async (req, res) => {
  const user = me(req);
  const c = await getComm(idParam(req));
  await requireCap(user, 'journal.business', 'crisis_review', 'communication', c.id);
  if (c.crisis !== 1 || c.status !== 'published') throw new HttpError(409, "Ce contenu n'est pas une communication de crise publiée.");
  const input = parse(z.object({ decision: z.enum(['confirm', 'withdraw']), note: z.string().trim().min(3, 'Une note de revue est obligatoire.').max(500) }), req.body);
  if (input.decision === 'withdraw') await db.prepare("UPDATE communications SET status='withdrawn', reviewed_at=?, review_note=?, updated_at=? WHERE id=?").run(now(), input.note, now(), c.id);
  else await db.prepare('UPDATE communications SET reviewed_at=?, review_note=?, updated_at=? WHERE id=?').run(now(), input.note, now(), c.id);
  await audit(user, 'business', 'crisis_review', 'communication', c.id, `Revue de la communication de crise « ${c.title} » : ${input.decision === 'withdraw' ? 'retirée' : 'confirmée'} — ${input.note}`);
  res.json({ communication: (await shapeComm((await getComm(c.id)), user, true)) });
});

// Retrait immédiat d'un contenu trompeur ou dangereux (Politique de communication §12.1).
communicationsApi.post('/communications/:id/withdraw', async (req, res) => {
  const user = me(req);
  const c = await getComm(idParam(req));
  await requireCap(user, 'comm.withdraw', 'comm_withdraw', 'communication', c.id);
  if (c.status !== 'published') throw new HttpError(409, "Seul un contenu publié peut être retiré.");
  const { motive } = parse(z.object({ motive: z.string().trim().min(3, 'Le motif est obligatoire.').max(500) }), req.body);
  await db.prepare("UPDATE communications SET status='withdrawn', decision_motive=?, updated_at=? WHERE id=?").run(motive, now(), c.id);
  await audit(user, 'business', 'comm_withdraw', 'communication', c.id, `Contenu retiré : « ${c.title} » — ${motive}`);
  await notifyTeam(`Contenu retiré : ${c.title}`, c, user.id);
  res.json({ communication: (await shapeComm((await getComm(c.id)), user, true)) });
});
