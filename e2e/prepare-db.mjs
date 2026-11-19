// Prépare une base PostgreSQL vierge pour les tests navigateur (supprimée puis recréée).
import pg from 'pg';

const target = new URL(process.env.E2E_DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:5432/linklink_e2e');
const name = target.pathname.slice(1);
if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`Nom de base refusé : ${name}`);
const admin = new URL(target);
admin.pathname = '/postgres';
const c = new pg.Client({ connectionString: admin.toString() });
await c.connect();
await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
await c.query(`CREATE DATABASE ${name}`);
await c.end();
console.log(`Base de test prête : ${name}`);
