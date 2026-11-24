import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import type { NextFunction, Request, Response } from 'express';
import { uid } from './db.js';
import { HttpError } from './http.js';
import { removeStored, TMP_DIR } from './storage.js';

export { removeStored };

export const MAX_UPLOAD = (Number(process.env.MAX_UPLOAD_MB) || 25) * 1024 * 1024;

// Liste blanche (cahier F-FILE-01). Le type MIME est déduit de l'extension, jamais du client.
const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  txt: 'text/plain',
  csv: 'text/csv',
  md: 'text/markdown',
  rtf: 'application/rtf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  zip: 'application/zip',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
};
export const PREVIEWABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export const ALLOWED_EXTENSIONS = Object.keys(MIME);

export function mimeFor(filename: string): string | null {
  const ext = path.extname(filename).slice(1).toLowerCase();
  return MIME[ext] ?? null;
}

const startsWith = (b: Buffer, hex: string, at = 0) => b.subarray(at, at + hex.length / 2).toString('hex') === hex.toLowerCase();
const ascii = (b: Buffer, text: string, at = 0) => b.subarray(at, at + text.length).toString('latin1') === text;
const ZIP = (b: Buffer) => startsWith(b, '504b0304') || startsWith(b, '504b0506');
const OLE = (b: Buffer) => startsWith(b, 'd0cf11e0a1b11ae1');
const ISO_BMFF = (b: Buffer) => ascii(b, 'ftyp', 4) || ['moov', 'mdat', 'free', 'wide', 'skip'].some((t) => ascii(b, t, 4));

/** Signatures (« magic numbers ») attendues par extension : l'extension ne suffit pas. */
const IMAGE = (b: Buffer) =>
  startsWith(b, '89504e470d0a1a0a') || startsWith(b, 'ffd8ff') || ascii(b, 'GIF87a') || ascii(b, 'GIF89a') || (ascii(b, 'RIFF') && ascii(b, 'WEBP', 8));
const SIGNATURES: Record<string, (b: Buffer) => boolean> = {
  pdf: (b) => ascii(b, '%PDF'),
  // Images : n'importe quel vrai format d'image est accepté (un JPEG renommé en .png est courant) ; un faux fichier non.
  png: IMAGE, jpg: IMAGE, jpeg: IMAGE, gif: IMAGE, webp: IMAGE,
  zip: ZIP,
  docx: ZIP, xlsx: ZIP, pptx: ZIP, odt: ZIP, ods: ZIP, odp: ZIP,
  doc: OLE, xls: OLE, ppt: OLE,
  rtf: (b) => ascii(b, '{\\rtf'),
  mp3: (b) => ascii(b, 'ID3') || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0),
  mp4: ISO_BMFF, mov: ISO_BMFF, m4a: ISO_BMFF,
  webm: (b) => startsWith(b, '1a45dfa3'),
  ogg: (b) => ascii(b, 'OggS'),
};
const TEXT_EXT = new Set(['txt', 'csv', 'md']);

/** Vrai si le contenu correspond à l'extension déclarée. Texte : aucun octet nul. */
export async function contentMatches(filePath: string, filename: string): Promise<boolean> {
  const ext = path.extname(filename).slice(1).toLowerCase();
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const head = Buffer.alloc(4096);
    const { bytesRead } = await fh.read(head, 0, head.length, 0);
    const b = head.subarray(0, bytesRead);
    if (TEXT_EXT.has(ext)) return !b.includes(0);
    const check = SIGNATURES[ext];
    return check ? check(b) : true;
  } finally {
    await fh.close();
  }
}

export const upload = multer({
  storage: multer.diskStorage({ destination: TMP_DIR, filename: (_req, _f, cb) => cb(null, uid()) }),
  limits: { fileSize: MAX_UPLOAD, files: 1 },
});

/** multer lit les noms en latin1 : on les remet en UTF-8 (accents). */
export const cleanName = (original: string) =>
  Buffer.from(original, 'latin1').toString('utf8').replace(/[\\/\0]/g, '_').slice(0, 200) || 'fichier';

export function receiveFile(req: Request, res: Response, next: NextFunction) {
  upload.single('file')(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      return next(
        new HttpError(tooBig ? 413 : 400, tooBig ? `Fichier trop volumineux (${MAX_UPLOAD / 1024 / 1024} Mo maximum).` : err.message),
      );
    }
    if (err) return next(err);
    const f = req.file;
    if (f && !mimeFor(cleanName(f.originalname))) {
      fs.rm(f.path, { force: true }, () => {});
      return next(new HttpError(415, "Ce type de fichier n'est pas accepté (PDF, Office, images, ZIP, vidéos légères, texte)."));
    }
    if (!f) return next();
    contentMatches(f.path, cleanName(f.originalname)).then(
      (ok) => {
        if (ok) return next();
        fs.rm(f.path, { force: true }, () => {});
        next(new HttpError(415, "Le contenu du fichier ne correspond pas à son extension : envoi refusé."));
      },
      (e) => {
        fs.rm(f.path, { force: true }, () => {});
        next(e);
      },
    );
  });
}
