import compression from 'compression';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { getSetting } from './db.js';
import { startJobs } from './jobs.js';
import { attachRealtime } from './realtime.js';
import { api, errorHandler } from './routes/index.js';

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

server.listen(PORT, () => {
  console.log(`LinkLink : http://localhost:${PORT}`);
  console.log(`Code d'invitation (Fondateurs) : ${getSetting('invite_code')}`);
  console.log(`Code d'invitation (Invités internes) : ${getSetting('guest_invite_code')}`);
  console.log('(Le tout premier compte créé devient Super Admin.)');
  startJobs();
});
