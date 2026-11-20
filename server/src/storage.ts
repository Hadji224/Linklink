import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DATA_DIR, UPLOAD_DIR, db, getSetting, now, setSetting, uid } from './db.js';
import { HttpError } from './http.js';

/**
 * Stockage des fichiers déposés. Deux moteurs :
 *  - Google Drive (OAuth, jeton de renouvellement) quand GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET et GOOGLE_REFRESH_TOKEN sont définis ;
 *  - le disque local sinon (éphémère sur les hébergements gratuits : à éviter en production) ;
 *  - la base de données (clés « db:<id> ») pour les pièces jointes des salons : relais temporaire à la manière de WhatsApp,
 *    purgé après CHAT_FILE_RETENTION_DAYS jours ; les appareils gardent leur copie (cache du navigateur).
 * La clé enregistrée dans files.stored_name dit où est le fichier : « drive:<id> », « db:<id> » ou un identifiant local.
 * Les deux moteurs coexistent : changer de moteur ne casse pas les anciens fichiers.
 */
export const TMP_DIR = path.join(DATA_DIR, 'tmp');
fs.mkdirSync(TMP_DIR, { recursive: true });

export interface StoredObject {
  stream: Readable;
  size?: number;
}
export interface PutMeta {
  name: string;
  mime: string;
}

const LOCAL_KEY = /^[0-9a-f-]{36}$/;
const DRIVE_ID = /^[A-Za-z0-9_-]{10,100}$/;
const notFound = () => new HttpError(404, 'Fichier introuvable dans le stockage.');

/* --------------------------------- Disque local --------------------------------- */
const local = {
  async put(tmpPath: string): Promise<string> {
    const key = uid();
    try {
      await fs.promises.rename(tmpPath, path.join(UPLOAD_DIR, key));
    } catch {
      await fs.promises.copyFile(tmpPath, path.join(UPLOAD_DIR, key)); // autre volume
      await fs.promises.rm(tmpPath, { force: true });
    }
    return key;
  },
  async open(key: string): Promise<StoredObject> {
    if (!LOCAL_KEY.test(key)) throw notFound();
    const p = path.join(UPLOAD_DIR, key);
    const st = await fs.promises.stat(p).catch(() => null);
    if (!st?.isFile()) throw notFound();
    return { stream: fs.createReadStream(p), size: st.size };
  },
  async remove(keys: string[]) {
    for (const k of keys) if (LOCAL_KEY.test(k)) await fs.promises.rm(path.join(UPLOAD_DIR, k), { force: true });
  },
};

/* ---------------------------------- Google Drive ---------------------------------- */
const env = () => ({
  clientId: process.env.GOOGLE_CLIENT_ID ?? '',
  clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
  refreshToken: process.env.GOOGLE_REFRESH_TOKEN ?? '',
  apiBase: (process.env.GOOGLE_API_BASE ?? 'https://www.googleapis.com').replace(/\/+$/, ''),
  tokenUrl: process.env.GOOGLE_TOKEN_URL ?? 'https://oauth2.googleapis.com/token',
  folderName: process.env.GOOGLE_DRIVE_FOLDER_NAME ?? 'LinkLink',
  folderId: process.env.GOOGLE_DRIVE_FOLDER_ID ?? '',
});
export const driveConfigured = () => {
  const e = env();
  return !!(e.clientId && e.clientSecret && e.refreshToken);
};

const unavailable = (detail: string) => {
  console.error(`Google Drive : ${detail}`);
  return new HttpError(502, 'Le stockage Google Drive est momentanément indisponible. Réessayez dans un instant.');
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let token: { value: string; expiresAt: number } | null = null;
let folderCache: string | null = null;

async function accessToken(force = false): Promise<string> {
  if (!force && token && token.expiresAt > Date.now() + 60_000) return token.value;
  const e = env();
  const res = await fetch(e.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: e.clientId, client_secret: e.clientSecret, refresh_token: e.refreshToken, grant_type: 'refresh_token' }),
  }).catch((err) => {
    throw unavailable(`jeton injoignable (${err.message})`);
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !data.access_token) {
    // invalid_grant : jeton révoqué, ou écran de consentement resté en mode « Test » (jeton valable 7 jours seulement).
    throw unavailable(`jeton refusé (${data.error ?? res.status} ${data.error_description ?? ''}) — refaire l'autorisation (npm run drive:auth)`);
  }
  token = { value: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return token.value;
}

/** Appel Drive avec renouvellement du jeton (401) et nouvelles tentatives (429, 5xx, réseau). */
async function drive(url: string, init: RequestInit = {}): Promise<Response> {
  let refreshed = false;
  for (let attempt = 0; ; attempt++) {
    let res: Response | null = null;
    try {
      res = await fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${await accessToken()}` } });
    } catch (err) {
      if (attempt >= 3) throw unavailable(`réseau (${(err as Error).message})`);
    }
    if (res) {
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await accessToken(true);
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await res.arrayBuffer().catch(() => {});
      } else return res;
    }
    await sleep(300 * 2 ** attempt);
  }
}

async function rootFolder(): Promise<string> {
  const e = env();
  if (e.folderId) return e.folderId;
  if (folderCache) return folderCache;
  const stored = await getSetting('drive_folder_id');
  if (stored) {
    const r = await drive(`${e.apiBase}/drive/v3/files/${encodeURIComponent(stored)}?fields=id,trashed`);
    if (r.ok && !((await r.json()) as { trashed?: boolean }).trashed) return (folderCache = stored);
  }
  // Le dossier est créé par l'application elle-même (portée « drive.file » : elle ne voit que ce qu'elle a créé).
  const q = `name='${e.folderName.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const found = await drive(`${e.apiBase}/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`);
  const existing = found.ok ? ((await found.json()) as { files?: { id: string }[] }).files?.[0]?.id : undefined;
  let id = existing;
  if (!id) {
    const created = await drive(`${e.apiBase}/drive/v3/files?fields=id`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: e.folderName, mimeType: 'application/vnd.google-apps.folder' }),
    });
    if (!created.ok) throw unavailable(`création du dossier impossible (${created.status})`);
    id = ((await created.json()) as { id: string }).id;
  }
  await setSetting('drive_folder_id', id);
  return (folderCache = id);
}

const driveStore = {
  async put(tmpPath: string, meta: PutMeta): Promise<string> {
    const e = env();
    const parent = await rootFolder();
    const data = await fs.promises.readFile(tmpPath);
    const boundary = `ll${uid().replace(/-/g, '')}`;
    const head = Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: meta.name, parents: [parent] })}\r\n` +
        `--${boundary}\r\nContent-Type: ${meta.mime}\r\n\r\n`,
    );
    const body = Buffer.concat([head, data, Buffer.from(`\r\n--${boundary}--`)]);
    const res = await drive(`${e.apiBase}/upload/drive/v3/files?uploadType=multipart&fields=id`, {
      method: 'POST',
      headers: { 'content-type': `multipart/related; boundary=${boundary}`, 'content-length': String(body.length) },
      body,
    });
    if (!res.ok) throw unavailable(`envoi refusé (${res.status} ${(await res.text()).slice(0, 200)})`);
    const id = ((await res.json()) as { id?: string }).id;
    if (!id || !DRIVE_ID.test(id)) throw unavailable('réponse inattendue à l\'envoi');
    await fs.promises.rm(tmpPath, { force: true });
    return `drive:${id}`;
  },
  async open(key: string): Promise<StoredObject> {
    const id = key.slice(6);
    if (!DRIVE_ID.test(id)) throw notFound();
    const res = await drive(`${env().apiBase}/drive/v3/files/${id}?alt=media`);
    if (res.status === 404) throw notFound();
    if (!res.ok || !res.body) throw unavailable(`lecture refusée (${res.status})`);
    const len = Number(res.headers.get('content-length'));
    return { stream: Readable.fromWeb(res.body as never), size: Number.isFinite(len) && len > 0 ? len : undefined };
  },
  async remove(keys: string[]) {
    for (const k of keys) {
      const id = k.slice(6);
      if (!DRIVE_ID.test(id)) continue;
      const res = await drive(`${env().apiBase}/drive/v3/files/${id}`, { method: 'DELETE' }); // suppression définitive (droit à l'oubli)
      if (!res.ok && res.status !== 404) console.error(`Google Drive : suppression de ${id} refusée (${res.status})`);
      else await res.arrayBuffer().catch(() => {});
    }
  },
};

/* ------------------------------ Base de données (relais) ------------------------------ */
const DB_KEY = /^db:[0-9a-f-]{36}$/;
const dbStore = {
  async put(tmpPath: string): Promise<string> {
    const data = await fs.promises.readFile(tmpPath);
    const key = `db:${uid()}`;
    await db.run('INSERT INTO file_blobs (key,data,size,created_at) VALUES (?,?,?,?)', key, data, data.length, now());
    await fs.promises.rm(tmpPath, { force: true });
    return key;
  },
  async open(key: string): Promise<StoredObject> {
    if (!DB_KEY.test(key)) throw notFound();
    const row = await db.get<{ data: Buffer }>('SELECT data FROM file_blobs WHERE key = ?', key);
    if (!row) throw new HttpError(410, 'Ce fichier a expiré sur le serveur. Si vous l\'avez déjà ouvert sur cet appareil, il y est conservé.');
    return { stream: Readable.from([row.data]), size: row.data.length };
  },
  async remove(keys: string[]) {
    const valid = keys.filter((k) => DB_KEY.test(k));
    if (valid.length) await db.run('DELETE FROM file_blobs WHERE key = ANY(?)', valid as never);
  },
};

/* ------------------------------------ Façade ------------------------------------ */
export const storageName = () => (driveConfigured() ? 'drive' : 'local');
const isDriveKey = (k: string) => k.startsWith('drive:');
const isDbKey = (k: string) => k.startsWith('db:');

export const storage = {
  /** Range le fichier reçu (chemin temporaire) et renvoie la clé à enregistrer. Le fichier temporaire disparaît. */
  put(tmpPath: string, meta: PutMeta, target: 'documents' | 'chat' = 'documents'): Promise<string> {
    if (target === 'chat') return dbStore.put(tmpPath); // pièces jointes des salons : relais temporaire
    return driveConfigured() ? driveStore.put(tmpPath, meta) : local.put(tmpPath);
  },
  open(key: string): Promise<StoredObject> {
    if (isDbKey(key)) return dbStore.open(key);
    if (!isDriveKey(key)) return local.open(key);
    if (!driveConfigured()) throw new HttpError(503, "Ce fichier est sur Google Drive, qui n'est pas configuré sur ce serveur.");
    return driveStore.open(key);
  },
  async remove(keys: string[]) {
    const b = keys.filter(isDbKey);
    const d = keys.filter(isDriveKey);
    const l = keys.filter((k) => !isDriveKey(k) && !isDbKey(k));
    if (b.length) await dbStore.remove(b);
    if (l.length) await local.remove(l);
    if (d.length) {
      if (!driveConfigured()) return console.error(`Google Drive non configuré : ${d.length} fichier(s) non supprimé(s)`);
      await driveStore.remove(d);
    }
  },
};

/** Suppression sans attendre (la ligne en base est déjà supprimée) ; une erreur est journalisée, jamais renvoyée à l'utilisateur. */
export const removeStored = (keys: string[]) => {
  if (!keys.length) return;
  void storage.remove(keys).catch((e) => console.error('Suppression de fichier(s) en échec :', e instanceof Error ? e.message : e));
};

/** Vérification au démarrage (journal) : le moteur actif est-il réellement utilisable ? */
export async function checkStorage(): Promise<string> {
  if (!driveConfigured()) {
    return process.env.RENDER
      ? 'ATTENTION — disque local : les fichiers seront effacés à chaque redémarrage sur Render. Configurez Google Drive (docs/stockage-google-drive.md).'
      : 'disque local';
  }
  try {
    await accessToken();
    await rootFolder();
    return 'Google Drive (connexion et dossier vérifiés)';
  } catch {
    return 'Google Drive INDISPONIBLE — voir le message ci-dessus ; les envois de fichiers échoueront tant que ce n\'est pas corrigé.';
  }
}
