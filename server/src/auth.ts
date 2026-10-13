import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { db, getSetting, type UserRow } from './db.js';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'member';
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

const secret = () => getSetting('jwt_secret') as string;

export function signToken(userId: string) {
  return jwt.sign({ sub: userId }, secret(), { expiresIn: '30d' });
}

export function userFromToken(token: string | undefined | null): AuthUser | null {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, secret()) as { sub?: string };
    if (!payload.sub) return null;
    const row = db
      .prepare('SELECT id, name, email, role FROM users WHERE id = ?')
      .get(payload.sub) as Pick<UserRow, 'id' | 'name' | 'email' | 'role'> | undefined;
    return row ? { id: row.id, name: row.name, email: row.email, role: row.role } : null;
  } catch {
    return null;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.header('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  const user = userFromToken(token);
  if (!user) {
    res.status(401).json({ error: 'Connexion requise.' });
    return;
  }
  req.user = user;
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ error: 'Réservé aux administrateurs.' });
    return;
  }
  next();
}

// Limiteur très simple (en mémoire) contre les essais répétés de mot de passe.
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
  if (entry.count > 30) {
    res.status(429).json({ error: 'Trop de tentatives. Réessayez dans quelques minutes.' });
    return;
  }
  next();
}
