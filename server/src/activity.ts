import { db, now, uid } from './db.js';
import type { AuthUser } from './http.js';

export function logActivity(
  user: Pick<AuthUser, 'id' | 'name'> | null,
  action: string,
  entity: string,
  entityId: string,
  summary: string,
  projectId: string | null = null,
) {
  db.prepare(
    'INSERT INTO activity_log (id,user_id,user_name,action,entity,entity_id,project_id,summary,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
  ).run(uid(), user?.id ?? null, user?.name ?? 'Système', action, entity, entityId, projectId, summary.slice(0, 300), now());
}
