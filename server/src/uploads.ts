import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import type { NextFunction, Request, Response } from 'express';
import { UPLOAD_DIR, uid } from './db.js';
import { HttpError } from './http.js';

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

export const upload = multer({
  storage: multer.diskStorage({ destination: UPLOAD_DIR, filename: (_req, _f, cb) => cb(null, uid()) }),
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
    next();
  });
}

export const removeStored = (storedNames: string[]) => {
  for (const n of storedNames) fs.rm(path.join(UPLOAD_DIR, n), { force: true }, () => {});
};
