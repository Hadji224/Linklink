import type { NextFunction, Request, Response } from 'express';
import { acquireRequestLock } from './db.js';

/**
 * Sérialise les requêtes qui modifient des données (POST, PATCH, PUT, DELETE), une à la fois.
 * SQLite exécutait déjà chaque gestionnaire d'un bloc ; avec PostgreSQL deux requêtes peuvent s'entrelacer
 * (deux approbations simultanées, deux inscriptions « premier compte »...). Les lectures ne sont jamais bloquées.
 *
 * Deux niveaux : une file dans ce processus (ordre d'arrivée, pas de connexions gaspillées à attendre), puis un verrou
 * PostgreSQL qui étend la même règle à plusieurs instances du serveur. Si la base ne répond pas au verrou, on continue
 * avec la seule file locale : les écritures sensibles se revérifient de toute façon sous verrou de transaction (`tx`).
 *
 * Exceptions : l'envoi de fichier (long, il ne touche aucune règle partagée), la connexion et les tickets WebSocket.
 */
let tail: Promise<void> = Promise.resolve();
const READ = new Set(['GET', 'HEAD', 'OPTIONS']);
const SKIP_POST = new Set(['/files', '/auth/login', '/ws-ticket']);
const MAX_HOLD_MS = 30_000;

export function serializeWrites(req: Request, res: Response, next: NextFunction) {
  if (READ.has(req.method) || (req.method === 'POST' && SKIP_POST.has(req.path))) return next();
  let release: () => void = () => {};
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = tail;
  tail = mine;
  let finished = false;
  let unlock: (() => Promise<void>) | null = null;
  const done = () => {
    finished = true;
    clearTimeout(timer);
    release();
    void unlock?.();
  };
  const timer = setTimeout(done, MAX_HOLD_MS); // filet de sécurité : une requête bloquée ne gèle jamais les autres
  res.once('close', done); // 'close' : réponse terminée ou connexion coupée
  void previous.then(async () => {
    if (finished || res.destroyed || res.writableEnded) return done();
    try {
      unlock = await acquireRequestLock();
    } catch (e) {
      console.error('Verrou d\'écriture PostgreSQL indisponible, file locale seule :', e instanceof Error ? e.message : e);
    }
    if (finished || res.destroyed || res.writableEnded) return done();
    next();
  });
}
