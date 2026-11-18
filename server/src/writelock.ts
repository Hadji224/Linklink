import type { NextFunction, Request, Response } from 'express';

/**
 * Sérialise les requêtes qui modifient des données (POST, PATCH, PUT, DELETE), une à la fois.
 * SQLite exécutait déjà chaque gestionnaire d'un bloc ; avec PostgreSQL deux requêtes peuvent s'entrelacer
 * (deux approbations simultanées, deux inscriptions « premier compte »...). Les lectures ne sont jamais bloquées.
 * Exceptions : l'envoi de fichier (long, il ne touche aucune règle partagée) et la connexion.
 */
let tail: Promise<void> = Promise.resolve();
const READ = new Set(['GET', 'HEAD', 'OPTIONS']);
const MAX_HOLD_MS = 30_000;

export function serializeWrites(req: Request, res: Response, next: NextFunction) {
  if (READ.has(req.method) || (req.method === 'POST' && (req.path === '/files' || req.path === '/auth/login'))) return next();
  let release: () => void = () => {};
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = tail;
  tail = mine;
  const timer = setTimeout(release, MAX_HOLD_MS); // filet de sécurité : une requête bloquée ne gèle jamais les autres
  const done = () => {
    clearTimeout(timer);
    release();
  };
  res.once('close', done); // 'close' : réponse terminée ou connexion coupée
  void previous.then(() => {
    if (res.destroyed || res.writableEnded) return done();
    next();
  });
}
