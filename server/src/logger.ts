import type { NextFunction, Request, Response } from 'express';
import { db } from './db.js';

const RETENTION_DAYS = 365; // journaux d'accès conservés 12 mois (cahier §6.6)

interface Line { t: string; ip: string | null; user: string | null; method: string; path: string; status: number; ms: number }

/**
 * Journal d'accès : une ligne par requête API (adresse, compte, méthode, chemin sans paramètres, statut, durée) — aucun contenu.
 * Stocké dans PostgreSQL (le disque de Render est effacé à chaque redémarrage) ; écrit par lots toutes les 5 s pour ne
 * pas ajouter une écriture à chaque requête.
 */
let buffer: Line[] = [];
let flushing = false;

export async function flushAccessLogs() {
  if (flushing || !buffer.length) return;
  flushing = true;
  const batch = buffer.splice(0, 500);
  try {
    const values: string[] = [];
    const params: (string | number | null)[] = [];
    for (const l of batch) {
      values.push('(?,?,?,?,?,?,?)');
      params.push(l.t, l.ip, l.user, l.method, l.path, l.status, l.ms);
    }
    await db.run(`INSERT INTO access_logs (t,ip,user_id,method,path,status,ms) VALUES ${values.join(',')}`, ...params);
  } catch (e) {
    console.error('Journal d\'accès : écriture impossible', e instanceof Error ? e.message : e);
  } finally {
    flushing = false;
  }
}

export function startAccessLogFlush() {
  setInterval(() => void flushAccessLogs(), 5_000).unref();
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => void flushAccessLogs().finally(() => process.exit(0)));
  }
}

export function accessLogger(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  res.on('finish', () => {
    const path = req.originalUrl.split('?')[0] ?? '';
    if (path === '/api/health') return; // la sonde de santé (toutes les 30 s) noierait le journal
    if (buffer.length > 5000) buffer.shift(); // base injoignable : on garde les plus récentes sans saturer la mémoire
    buffer.push({ t: new Date().toISOString(), ip: req.ip ?? null, user: req.user?.id ?? null, method: req.method, path: path.slice(0, 300), status: res.statusCode, ms: Date.now() - start });
  });
  next();
}

export async function purgeOldLogs() {
  const limit = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString();
  await db.run('DELETE FROM access_logs WHERE t < ?', limit);
}
