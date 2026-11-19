import 'express-async-errors';
import compression from 'compression';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { getSetting } from './db.js';
import { checkStorage } from './storage.js';
import { startJobs } from './jobs.js';
import { attachRealtime } from './realtime.js';
import { api, errorHandler } from './routes/index.js';

// Un échec ponctuel (base de données injoignable...) ne doit pas arrêter le serveur.
process.on('unhandledRejection', (e) => console.error('Promesse rejetée non gérée :', e));

const PORT = Number(process.env.PORT ?? 3000);
const WEB_DIST = path.resolve(import.meta.dirname, '../../web/dist');
const PROD = process.env.NODE_ENV === 'production';

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : process.env.TRUST_PROXY);

app.use(compression());
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  );
  next();
});

// Interface hébergée ailleurs (ex. Vercel) : CORS_ORIGIN = liste d'origines autorisées, séparées par des virgules.
// Pas de cookies (jeton en en-tête Authorization) : aucun risque CSRF, seules les origines listées lisent les réponses.
const CORS_ORIGINS = (process.env.CORS_ORIGIN ?? '').split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);
if (CORS_ORIGINS.length) {
  app.use('/api', (req, res, next) => {
    const origin = req.header('origin');
    if (origin && CORS_ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Expose-Headers', 'content-disposition');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return void res.status(204).end();
    next();
  });
}

app.use('/api', express.json({ limit: '100kb' }), api);
app.use(errorHandler);

if (fs.existsSync(path.join(WEB_DIST, 'index.html'))) {
  app.use('/assets', express.static(path.join(WEB_DIST, 'assets'), { immutable: true, maxAge: '1y' }));
  app.use(express.static(WEB_DIST, { index: false, maxAge: '1h' }));
  app.get('*', (_req, res) => res.sendFile(path.join(WEB_DIST, 'index.html')));
} else {
  app.get('/', (_req, res) => {
    res.type('text').send("API LinkLink en marche. Lancez 'npm run build' pour servir l'interface web.");
  });
}

const server = http.createServer(app);
attachRealtime(server);

server.listen(PORT, async () => {
  console.log(`LinkLink : http://localhost:${PORT}`);
  console.log(`Code d'invitation (Fondateurs) : ${(await getSetting('invite_code'))}`);
  console.log(`Code d'invitation (Invités internes) : ${(await getSetting('guest_invite_code'))}`);
  console.log("(Le tout premier compte créé devient Administrateur technique, PDG de démarrage.)");
  console.log(`Stockage des fichiers : ${await checkStorage()}`);
  startJobs();
});
