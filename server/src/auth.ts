import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { db, jwtSecret, type Role, type UserRow } from './db.js';
import type { AuthUser } from './http.js';

export type { AuthUser };

/** Session de 7 jours, renouvelée automatiquement tant que la personne se sert de l'application (voir requireAuth). */
export const SESSION_DAYS = 7;
const RENEW_AFTER_MS = 24 * 3600_000;

export function signToken(user: Pick<UserRow, 'id' | 'token_version'>) {
  return jwt.sign({ sub: user.id, tv: user.token_version }, jwtSecret(), { expiresIn: `${SESSION_DAYS}d` });
}

export interface VerifiedToken { user: AuthUser; tokenVersion: number; issuedAt: number }

export async function verifyToken(token: string | undefined | null): Promise<VerifiedToken | null> {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, jwtSecret()) as { sub?: string; tv?: number; iat?: number };
    if (!payload.sub) return null;
    const row = await db
          .prepare('SELECT id, name, email, role, token_version, suspended_at FROM users WHERE id = ?')
          .get(payload.sub) as Pick<UserRow, 'id' | 'name' | 'email' | 'role' | 'token_version' | 'suspended_at'> | undefined;
    // Un changement de mot de passe ou de rôle invalide les anciennes sessions ; un compte suspendu n'a plus aucun accès.
    if (!row || row.suspended_at || (payload.tv ?? 0) !== row.token_version) return null;
    return { user: { id: row.id, name: row.name, email: row.email, role: row.role }, tokenVersion: row.token_version, issuedAt: (payload.iat ?? 0) * 1000 };
  } catch {
    return null;
  }
}

export async function userFromToken(token: string | undefined | null): Promise<AuthUser | null> {
  return (await verifyToken(token))?.user ?? null;
}

/** Compte actif (non suspendu) à partir de son identifiant : sert à la connexion WebSocket par ticket. */
export async function activeUserById(id: string): Promise<AuthUser | null> {
  const row = await db.prepare('SELECT id, name, email, role, suspended_at FROM users WHERE id = ?').get(id) as Pick<UserRow, 'id' | 'name' | 'email' | 'role' | 'suspended_at'> | undefined;
  return row && !row.suspended_at ? { id: row.id, name: row.name, email: row.email, role: row.role } : null;
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.header('authorization');
  const verified = await verifyToken(header?.startsWith('Bearer ') ? header.slice(7) : undefined);
  if (!verified) {
    res.status(401).json({ error: 'Connexion requise.' });
    return;
  }
  req.user = verified.user;
  // Session glissante : un jeton de plus d'un jour est remplacé par un neuf (l'application le range toute seule).
  if (Date.now() - verified.issuedAt > RENEW_AFTER_MS) {
    res.setHeader('X-Refreshed-Token', signToken({ id: verified.user.id, token_version: verified.tokenVersion }));
  }
  next();
}

export const requireRole =
  (...roles: Role[]) =>
  (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      res.status(403).json({ error: "Vous n'avez pas le droit d'effectuer cette action." });
      return;
    }
    next();
  };

export const requireAdmin = requireRole('admin');
/** Administrateur technique et Fondateurs (tout sauf les invités). */
export const requireStaff = requireRole('admin', 'member');
