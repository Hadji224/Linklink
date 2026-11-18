import { db } from './db.js';

/** Retrouve les personnes citées avec « @Prénom Nom » dans un texte (parmi les candidats autorisés). */
export async function findMentions(body: string, candidateIds: string[]): Promise<string[]> {
  const lower = body.toLowerCase();
  const users = await db.prepare('SELECT id, name FROM users').all() as { id: string; name: string }[];
  const allowed = new Set(candidateIds);
  return users
    .filter((u) => allowed.has(u.id) && lower.includes('@' + u.name.toLowerCase()))
    .map((u) => u.id);
}
