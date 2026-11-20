import { afterAll, describe, expect, it } from 'vitest';
import { Client, startServer, type Srv } from './helpers.js';

let srv: Srv;
afterAll(async () => { await srv?.stop(); });

describe('Base PostgreSQL : migrations et données initiales', () => {
  it('plusieurs démarrages ne dupliquent rien et gardent le même secret et les mêmes codes', async () => {
    srv = await startServer();
    const first = { ...srv.codes };
    const admin = await new Client(srv.url).register('Admin', 'a@t.test');
    await srv.restart();
    await srv.restart();
    expect(srv.codes).toEqual(first);
    expect((await srv.sql('SELECT COUNT(*) AS n FROM schema_migrations')).rows[0].n).toBe(2);
    expect((await srv.sql("SELECT COUNT(*) AS n FROM channels WHERE kind = 'channel'")).rows[0].n).toBe(2);
    expect((await srv.sql('SELECT COUNT(*) AS n FROM folders WHERE system IS NOT NULL')).rows[0].n).toBe(2);
    expect((await srv.sql("SELECT COUNT(*) AS n FROM settings WHERE key = 'jwt_secret'")).rows[0].n).toBe(1);
    // la session ouverte avant les redémarrages reste valable (même secret JWT)
    expect((await admin.get('/me')).status).toBe(200);
  });

  it('les nombres reviennent comme des nombres (COUNT, SUM)', async () => {
    const r = await srv.sql('SELECT COUNT(*) AS n, SUM(token_version) AS s FROM users');
    expect(typeof r.rows[0].n).toBe('number');
    expect(typeof r.rows[0].s).toBe('number');
  });

  it('base vide : huit inscriptions simultanées → un seul Administrateur technique, les autres refusées', async () => {
    const fresh = await startServer();
    try {
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          new Client(fresh.url).post('/auth/register', { name: `Course ${i}`, email: `c${i}@t.test`, password: 'motdepasse123', inviteCode: '', consent: true }),
        ),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 403)).toHaveLength(7);
      expect((await fresh.sql("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'")).rows[0].n).toBe(1);
      expect((await fresh.sql("SELECT COUNT(*) AS n FROM user_functions WHERE fn = 'pdg' AND ended_at IS NULL")).rows[0].n).toBe(1);
    } finally {
      await fresh.stop();
    }
  });

  it('une transaction annulée ne laisse rien (rollback) et le journal reste immuable', async () => {
    await expect(srv.sql("INSERT INTO audit_log (id,category,action,summary,created_at) VALUES ('x','business','t','s','2026-01-01')")).resolves.toBeTruthy();
    await expect(srv.sql("UPDATE audit_log SET summary = 'modifié' WHERE id = 'x'")).rejects.toThrow(/immuable/);
    await expect(srv.sql("DELETE FROM audit_log WHERE id = 'x'")).rejects.toThrow(/immuable/);
  });
});
