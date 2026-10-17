import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export interface Srv {
  url: string;
  dataDir: string;
  codes: { member: string; guest: string };
  stop: () => Promise<void>;
  restart: () => Promise<void>;
}

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

export async function startServer(dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linklink-test-'))): Promise<Srv> {
  const port = await freePort();
  let child: ChildProcess;
  const codes = { member: '', guest: '' };
  const boot = () =>
    new Promise<void>((resolve, reject) => {
      child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
        cwd: path.resolve(import.meta.dirname, '..'),
        env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, AUTH_RATE_LIMIT: '10000', NODE_ENV: 'test' },
      });
      let out = '';
      child.stdout?.on('data', (d) => {
        out += d;
        const m = /Fondateurs\) : (\S+)/.exec(out);
        const g = /Invités internes\) : (\S+)/.exec(out);
        if (m && g && out.includes('Le tout premier')) {
          codes.member = m[1] as string;
          codes.guest = g[1] as string;
          // laisse les tâches de démarrage (rappels, sauvegarde) se terminer
          setTimeout(resolve, 150);
        }
      });
      child.stderr?.on('data', (d) => process.stderr.write(d));
      child.on('exit', (c) => reject(new Error(`serveur arrêté (${c})`)));
    });
  const kill = () =>
    new Promise<void>((resolve) => {
      child.removeAllListeners('exit');
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
    });
  await boot();
  return {
    url: `http://localhost:${port}`,
    dataDir,
    codes,
    stop: kill,
    restart: async () => {
      await kill();
      await boot();
    },
  };
}

export class Client {
  token = '';
  user: { id: string; name: string; role: string; email: string } = { id: '', name: '', role: '', email: '' };
  constructor(public base: string) {}

  async req(method: string, p: string, body?: unknown, raw = false): Promise<{ status: number; data: any; res: Response }> {
    const headers: Record<string, string> = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(this.base + '/api' + p, { method, headers, body: payload });
    const ct = res.headers.get('content-type') ?? '';
    const data = raw ? null : ct.includes('json') ? await res.json() : null;
    return { status: res.status, data, res };
  }
  get = (p: string) => this.req('GET', p);
  post = (p: string, b?: unknown) => this.req('POST', p, b ?? {});
  patch = (p: string, b: unknown) => this.req('PATCH', p, b);
  del = (p: string, b?: unknown) => this.req('DELETE', p, b);

  async register(name: string, email: string, inviteCode = '') {
    const r = await this.post('/auth/register', { name, email, password: 'motdepasse123', inviteCode, consent: true });
    if (r.status !== 201) throw new Error(`inscription ${name} : ${r.status} ${JSON.stringify(r.data)}`);
    this.token = r.data.token;
    this.user = r.data.user;
    return this;
  }

  async upload(file: { name: string; content: string; type?: string }, fields: Record<string, string> = {}) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    fd.append('file', new Blob([file.content], { type: file.type ?? 'application/octet-stream' }), file.name);
    return this.req('POST', '/files', fd);
  }
}
