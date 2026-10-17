import type { Request } from 'express';
import { z, type ZodTypeAny } from 'zod';
import type { Role } from './db.js';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new HttpError(400, result.error.issues[0]?.message ?? 'Données invalides.');
  }
  return result.data;
}

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: Role;
}

export const me = (req: Request): AuthUser => req.user as AuthUser;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export const idParam = (req: Request, name = 'id') => String(req.params[name]);
