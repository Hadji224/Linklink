import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';

/**
 * Hachage des mots de passe et des codes secrets.
 *
 * scrypt s'exécute dans le pool de threads de Node : un calcul de ~50 ms ne bloque plus le serveur
 * (bcryptjs, en JavaScript pur, gelait toutes les requêtes et les WebSocket le temps du calcul).
 * Les anciens hachages bcrypt restent acceptés ; au premier bon mot de passe ils sont remplacés (`rehash`).
 */
const N = 16_384; // 2^14 : ~16 Mo de mémoire, ~50 ms
const R = 8;
const P = 1;
const KEYLEN = 32;
const MAXMEM = 64 * 1024 * 1024;

const scryptAsync = (secret: string, salt: Buffer, n: number, r: number, p: number, keylen: number) =>
  new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(secret.normalize('NFKC'), salt, keylen, { N: n, r, p, maxmem: MAXMEM }, (err, key) => (err ? reject(err) : resolve(key)));
  });

export async function hashPassword(secret: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(secret, salt, N, R, P, KEYLEN);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export interface Verification {
  ok: boolean;
  /** Bon secret, mais le hachage stocké est ancien (bcrypt) ou moins coûteux : à remplacer. */
  rehash: boolean;
}

export async function verifyPassword(secret: string, stored: string): Promise<Verification> {
  if (stored.startsWith('scrypt$')) {
    const [, n, r, p, salt, hash] = stored.split('$');
    if (!n || !r || !p || !salt || !hash) return { ok: false, rehash: false };
    const expected = Buffer.from(hash, 'base64');
    const key = await scryptAsync(secret, Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p), expected.length);
    const ok = key.length === expected.length && crypto.timingSafeEqual(key, expected);
    return { ok, rehash: ok && (Number(n) !== N || Number(r) !== R || Number(p) !== P) };
  }
  // Ancien format (bcrypt) : accepté une dernière fois, puis remplacé par scrypt.
  let ok = false;
  try {
    ok = bcrypt.compareSync(secret, stored);
  } catch {
    ok = false;
  }
  return { ok, rehash: ok };
}

/** Pour un compte inconnu : même durée de calcul que pour un vrai compte (on ne révèle pas quelles adresses existent). */
const DUMMY = hashPassword('motdepasse-factice-linklink');
export async function verifyDummy(secret: string): Promise<void> {
  await verifyPassword(secret, await DUMMY);
}

/** Comparaison de deux chaînes en temps constant (codes d'invitation, secret d'initialisation). */
export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}
