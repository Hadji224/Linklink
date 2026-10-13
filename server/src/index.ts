import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { getSetting } from './db.js';
import { attachRealtime } from './realtime.js';
import { api, errorHandler } from './routes.js';

const PORT = Number(process.env.PORT ?? 3000);
const WEB_DIST = path.resolve(import.meta.dirname, '../../web/dist');

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : process.env.TRUST_PROXY);

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
  );
  next();
});

app.use('/api', express.json({ limit: '100kb' }), api);
app.use(errorHandler);

// En production, le serveur distribue aussi l'interface web compilée (npm run build).
if (fs.existsSync(path.join(WEB_DIST, 'index.html'))) {
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
  console.log(`Code d'invitation pour les nouveaux membres : ${getSetting('invite_code')}`);
  console.log("(Le tout premier compte créé devient administrateur.)");
});
