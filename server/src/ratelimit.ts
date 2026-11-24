import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { adminIds, audit, pdgIds } from './access.js';
import { notify } from './notify.js';
import { db, now } from './db.js';
import { HttpError } from './http.js';

/**
 * Limitation des tentatives d'authentification, stockée dans PostgreSQL :
 * elle survit aux redémarrages (Render met le serveur en veille) et reste cohérente entre plusieurs instances.
 *
 *  - par IP : seuls les ÉCHECS comptent (un bureau entier derrière la même IP n'est pas bloqué par ses connexions réussies) ;
 *  - par compte : au-delà de quelques échecs, le compte refuse toute tentative pendant la fenêtre (temporaire : jamais de verrou
 *    permanent qui permettrait de bloquer quelqu'un exprès) ;
 *  - par IP, toutes tentatives confondues, avec un plafond large : il borne le coût de calcul des mots de passe.
 * Chaque dépassement est écrit dans le journal de sécurité.
 */
const num = (v: string | undefined, d: number) => (Number(v) > 0 ? Number(v) : d);
const windowMs = () => num(process.env.AUTH_WINDOW_MIN, 15) * 60_000;
const LIMIT_IP_FAIL = () => num(process.env.AUTH_FAIL_LIMIT_IP, 20);
const LIMIT_ACCOUNT_FAIL = () => num(process.env.AUTH_FAIL_LIMIT_ACCOUNT, 8);
const LIMIT_IP_ALL = () => num(process.env.AUTH_REQ_LIMIT_IP, 150);

const digest = (s: string) => crypto.createHash('sha256').update(s.toLowerCase()).digest('hex').slice(0, 24);
const ipOf = (req: Request) => req.ip ?? 'inconnue';

/** Ajoute 1 à un compteur à fenêtre fixe ; la fenêtre ne se prolonge pas quand on insiste. */
async function bump(key: string): Promise<{ count: number; resetAt: string }> {
  const t = now();
  const row = await db.get<{ count: number; reset_at: string }>(
    `INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?)
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN rate_limits.reset_at <= ? THEN 1 ELSE rate_limits.count + 1 END,
       reset_at = CASE WHEN rate_limits.reset_at <= ? THEN excluded.reset_at ELSE rate_limits.reset_at END
     RETURNING count, reset_at`,
    key, new Date(Date.now() + windowMs()).toISOString(), t, t,
  );
  return { count: row?.count ?? 1, resetAt: row?.reset_at ?? t };
}

async function peek(key: string): Promise<{ count: number; resetAt: string } | null> {
  const row = await db.get<{ count: number; reset_at: string }>('SELECT count, reset_at FROM rate_limits WHERE key = ? AND reset_at > ?', key, now());
  return row ? { count: row.count, resetAt: row.reset_at } : null;
}

function tooMany(resetAt: string): HttpError {
  const mins = Math.max(1, Math.ceil((Date.parse(resetAt) - Date.now()) / 60_000));
  return new HttpError(429, `Trop de tentatives. Réessayez dans ${mins} minute${mins > 1 ? 's' : ''}.`);
}

/** Barrière des routes d'authentification (inscription, connexion, mot de passe, suppression de compte). */
export async function authGate(req: Request, _res: Response, next: NextFunction) {
  const ip = ipOf(req);
  const failures = await peek(`fail:ip:${ip}`);
  if (failures && failures.count >= LIMIT_IP_FAIL()) throw tooMany(failures.resetAt);
  const all = await bump(`req:ip:${ip}`);
  if (all.count > LIMIT_IP_ALL()) throw tooMany(all.resetAt);
  next();
}

/** À appeler avant de vérifier un secret pour un compte donné (adresse e-mail, identifiant…). */
export async function assertAccountOpen(account: string) {
  const f = await peek(`fail:acct:${digest(account)}`);
  if (f && f.count >= LIMIT_ACCOUNT_FAIL()) throw tooMany(f.resetAt);
}

/** À appeler après un mauvais secret : compte l'échec pour l'IP et, si connu, pour le compte. */
export async function recordAuthFailure(req: Request, account?: string, label = 'connexion') {
  const ip = ipOf(req);
  const byIp = await bump(`fail:ip:${ip}`);
  if (byIp.count === LIMIT_IP_FAIL()) {
    await audit(null, 'security', 'auth_ip_throttled', 'ip', ip, `Trop d'échecs (${label}) depuis la même adresse : blocage temporaire`, { result: 'denied' });
  }
  if (account) {
    const byAccount = await bump(`fail:acct:${digest(account)}`);
    if (byAccount.count === LIMIT_ACCOUNT_FAIL()) {
      await audit(null, 'security', 'auth_account_throttled', 'account', digest(account), `Trop d'échecs (${label}) sur un même compte : blocage temporaire`, { result: 'denied' });
      const hour = now().slice(0, 13);
      for (const id of new Set([...(await pdgIds()), ...(await adminIds())])) {
        await notify({ userId: id, type: 'security', category: 'urgent', title: `Échecs de connexion répétés sur un compte (${label})`, body: 'Blocage temporaire du compte visé ; détails dans le journal de sécurité.', link: '#journal', dedupeKey: `throttle:${digest(account)}:${hour}` });
      }
    }
  }
}

/** Mot de passe correct : le compteur du compte repart de zéro (celui de l'IP, non : sinon un attaquant le remettrait à zéro avec son propre compte). */
export async function clearAccountFailures(account: string) {
  await db.run('DELETE FROM rate_limits WHERE key = ?', `fail:acct:${digest(account)}`);
}

export async function purgeRateLimits() {
  await db.run('DELETE FROM rate_limits WHERE reset_at <= ?', now());
}
