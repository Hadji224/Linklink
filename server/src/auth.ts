import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { db, jwtSecret, type Role, type UserRow } from './db.js';
import type { AuthUser } from './http.js';

export type { AuthUser };

export function signToken(user: Pick<UserRow, 'id' | 'token_version'>) {
  return jwt.sign({ sub: user.id, tv: user.token_version }, jwtSecret(), { expiresIn: '30d' });
}

export async function userFromToken(token: string | undefined | null): Promise<AuthUser | null> {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, jwtSecret()) as { sub?: string; tv?: number };
    if (!payload.sub) return null;
    const row = await db
          .prepare('SELECT id, name, email, role, token_version, suspended_at FROM users WHERE id = ?')
          .get(payload.sub) as Pick<UserRow, 'id' | 'name' | 'email' | 'role' | 'token_version' | 'suspended_at'> | undefined;
    // Un changement de mot de passe ou de rôle invalide les anciennes sessions ; un compte suspendu n'a plus aucun accès.
    if (!row || row.suspended_at || (payload.tv ?? 0) !== row.token_version) return null;
    return { id: row.id, name: row.name, email: row.email, role: row.role };
  } catch {
    return null;
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.header('authorization');
  const user = await userFromToken(header?.startsWith('Bearer ') ? header.slice(7) : undefined);
  if (!user) {
    res.status(401).json({ error: 'Connexion requise.' });
    return;
  }
  req.user = user;
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

// Limiteur en mémoire contre les essais répétés de mot de passe.
const attempts = new Map<string, { count: number; resetAt: number }>();
export function limitAuthAttempts(req: Request, res: Response, next: NextFunction) {
  const key = req.ip ?? 'unknown';
  const t = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.resetAt < t) {
    attempts.set(key, { count: 1, resetAt: t + 15 * 60 * 1000 });
    next();
    return;
  }
  entry.count += 1;
  if (entry.count > (Number(process.env.AUTH_RATE_LIMIT) || 30)) {
    res.status(429).json({ error: 'Trop de tentatives. Réessayez dans quelques minutes.' });
    return;
  }
  next();
}
