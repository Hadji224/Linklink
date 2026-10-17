import type { NextFunction, Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { LOG_DIR } from './db.js';

const RETENTION_DAYS = 365; // logs d'accès conservés 12 mois (cahier §6.6)

/** Journal d'accès : une ligne JSON par requête API, un fichier par mois. Aucune donnée de contenu. */
export function accessLogger(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  res.on('finish', () => {
    const line = JSON.stringify({
      t: new Date().toISOString(),
      ip: req.ip,
      user: req.user?.id ?? null,
      method: req.method,
      path: req.originalUrl.split('?')[0],
      status: res.statusCode,
      ms: Date.now() - start,
    });
    const file = path.join(LOG_DIR, `access-${new Date().toISOString().slice(0, 7)}.log`);
    fs.appendFile(file, line + '\n', () => {});
  });
  next();
}

export function purgeOldLogs() {
  const limit = Date.now() - RETENTION_DAYS * 86_400_000;
  for (const f of fs.readdirSync(LOG_DIR)) {
    const p = path.join(LOG_DIR, f);
    if (fs.statSync(p).mtimeMs < limit) fs.rmSync(p, { force: true });
  }
}
