import fs from 'node:fs/promises';
import { Router } from 'express';
import { audit, requireCap } from '../access.js';
import { getSetting, now, setSetting } from '../db.js';
import { HttpError, me } from '../http.js';
import { receiveFile } from '../uploads.js';

/** Logo personnalisé de la plateforme : lecture publique (écran de connexion), modification réservée (capacité `branding.edit`). */
export const brandingPublicApi = Router();
export const brandingApi = Router();

export const MAX_LOGO_BYTES = 1024 * 1024;

/** On ne se fie pas à l'extension : le type vient des premiers octets. SVG refusé (peut contenir du script). */
export function sniffImage(b: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (b.length > 12 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

async function current() {
  const [data, mime, version] = await Promise.all([getSetting('brand_logo'), getSetting('brand_logo_mime'), getSetting('brand_logo_version')]);
  return data && mime ? { data, mime, version: version ?? '0' } : null;
}

brandingPublicApi.get('/branding', async (_req, res) => {
  const c = await current();
  res.setHeader('Cache-Control', 'no-cache');
  res.json({ custom: !!c, version: c?.version ?? null });
});

brandingPublicApi.get('/branding/logo', async (_req, res) => {
  const c = await current();
  if (!c) throw new HttpError(404, 'Aucun logo personnalisé.');
  res.setHeader('Content-Type', c.mime);
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Content-Disposition', 'inline');
  res.send(Buffer.from(c.data, 'base64'));
});

brandingApi.put('/branding/logo', receiveFile, async (req, res) => {
  const user = me(req);
  const f = req.file;
  try {
    await requireCap(user, 'branding.edit', 'Changement du logo', 'settings', 'brand_logo');
    if (!f) throw new HttpError(400, 'Choisissez une image (PNG, JPEG ou WebP).');
    if (f.size > MAX_LOGO_BYTES) throw new HttpError(413, 'Logo trop lourd (1 Mo maximum).');
    const buf = await fs.readFile(f.path);
    const mime = sniffImage(buf);
    if (!mime) throw new HttpError(415, 'Format non accepté : utilisez une image PNG, JPEG ou WebP.');
    const version = String(Date.now());
    await setSetting('brand_logo', buf.toString('base64'));
    await setSetting('brand_logo_mime', mime);
    await setSetting('brand_logo_version', version);
    await audit(user, 'business', 'branding_logo_set', 'settings', 'brand_logo', `Logo de la plateforme remplacé (${Math.round(buf.length / 1024)} Ko)`);
    res.json({ custom: true, version, at: now() });
  } finally {
    if (f) await fs.rm(f.path, { force: true });
  }
});

brandingApi.delete('/branding/logo', async (req, res) => {
  const user = me(req);
  await requireCap(user, 'branding.edit', 'Retour au logo LinkLink', 'settings', 'brand_logo');
  for (const k of ['brand_logo', 'brand_logo_mime', 'brand_logo_version']) await setSetting(k, '');
  await audit(user, 'business', 'branding_logo_reset', 'settings', 'brand_logo', 'Logo LinkLink d’origine rétabli');
  res.json({ custom: false, version: null });
});
