import http from 'node:http';
import net from 'node:net';

/** Faux serveur Google (jeton OAuth + API Drive v3 minimale) pour tester l'adaptateur sans réseau. */
export interface FakeFile { id: string; name: string; parents: string[]; mime: string; data: Buffer; folder?: boolean }

export async function startFakeDrive() {
  const files = new Map<string, FakeFile>();
  const state = { tokens: 0, folderCreations: 0, failUploads: 0, expireNext: false, refreshToken: 'rt-test', current: '' };
  let seq = 0;
  const newId = () => `fake${String(++seq).padStart(8, '0')}abcdef`;

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url ?? '/', 'http://x');
    const json = (code: number, obj: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

    if (url.pathname === '/token') {
      const p = new URLSearchParams(body.toString());
      if (p.get('refresh_token') !== state.refreshToken) return json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
      state.tokens++;
      state.current = `tok${state.tokens}`;
      return json(200, { access_token: state.current, expires_in: 3600 });
    }
    if (state.expireNext) { state.expireNext = false; return json(401, { error: { code: 401 } }); }
    if (req.headers.authorization !== `Bearer ${state.current}`) return json(401, { error: { code: 401 } });

    if (req.method === 'GET' && url.pathname === '/drive/v3/files') {
      const q = url.searchParams.get('q') ?? '';
      const name = /name='(.*?)'/.exec(q)?.[1];
      return json(200, { files: [...files.values()].filter((f) => f.folder && f.name === name).map((f) => ({ id: f.id })) });
    }
    if (req.method === 'POST' && url.pathname === '/drive/v3/files') {
      const meta = JSON.parse(body.toString());
      const id = newId();
      state.folderCreations++;
      files.set(id, { id, name: meta.name, parents: [], mime: meta.mimeType, data: Buffer.alloc(0), folder: true });
      return json(200, { id });
    }
    if (req.method === 'POST' && url.pathname === '/upload/drive/v3/files') {
      if (state.failUploads > 0) { state.failUploads--; return json(500, { error: 'boom' }); }
      const boundary = /boundary=(.+)$/.exec(String(req.headers['content-type']))?.[1] ?? '';
      const parts = body.toString('latin1').split(`--${boundary}`).filter((p) => p.trim() && p.trim() !== '--');
      const raw = (i: number) => (parts[i] as string).slice((parts[i] as string).indexOf('\r\n\r\n') + 4, -2);
      const meta = JSON.parse(Buffer.from(raw(0), 'latin1').toString('utf8'));
      const mime = /Content-Type: (.+)\r\n/.exec(parts[1] as string)?.[1] ?? '';
      const id = newId();
      files.set(id, { id, name: meta.name, parents: meta.parents ?? [], mime, data: Buffer.from(raw(1), 'latin1') });
      return json(200, { id });
    }
    const m = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
    if (m) {
      const f = files.get(m[1] as string);
      if (!f) return json(404, { error: { code: 404 } });
      if (req.method === 'DELETE') { files.delete(f.id); res.writeHead(204); return void res.end(); }
      if (url.searchParams.get('alt') === 'media') { res.writeHead(200, { 'content-type': f.mime, 'content-length': f.data.length }); return void res.end(f.data); }
      return json(200, { id: f.id, trashed: false });
    }
    json(404, { error: 'inconnu' });
  });
  const port: number = await new Promise((resolve) => { const s = net.createServer().listen(0, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });
  await new Promise<void>((r) => server.listen(port, r));
  const base = `http://127.0.0.1:${port}`;
  return {
    files, state,
    env: { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csec', GOOGLE_REFRESH_TOKEN: 'rt-test', GOOGLE_API_BASE: base, GOOGLE_TOKEN_URL: `${base}/token` },
    userFiles: () => [...files.values()].filter((f) => !f.folder),
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}
