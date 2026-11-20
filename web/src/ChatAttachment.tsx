import { useEffect, useState } from 'react';
import { ApiError, downloadFile, fetchFileBlob } from './api';
import { formatSize } from './format';
import { getLocalFile } from './fileCache';
import type { FileRef } from './types';
import { Icon } from './ui';

const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Jours restants avant que le serveur ne supprime la pièce jointe (null si conservée ou déjà expirée). */
function daysLeft(file: FileRef): number | null {
  if (!file.expiresAt || file.expired) return null;
  return Math.max(0, Math.ceil((Date.parse(file.expiresAt) - Date.now()) / 86_400_000));
}

/**
 * Pièce jointe d'un message, à la manière de WhatsApp : les images s'affichent dans la bulle avec une icône
 * de téléchargement (toujours visible, pas seulement au survol) ; les autres fichiers sont une ligne cliquable.
 * Le serveur ne garde la pièce jointe que quelques jours : l'appareil en garde une copie dès qu'elle est ouverte.
 */
export function ChatAttachment({ file, mine, onError }: { file: FileRef; mine: boolean; onError: (message: string) => void }) {
  const isImage = IMAGE_MIME.has(file.mime);
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'expired' | 'error'>(isImage || file.expired ? 'loading' : 'ready');
  const [zoom, setZoom] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;
    if (!isImage) {
      // Fichier non image : seul cas à vérifier, l'expiration (une copie locale peut subsister).
      if (file.expired) void getLocalFile(file.id).then((b) => alive && setState(b ? 'ready' : 'expired'));
      return () => { alive = false; };
    }
    setState('loading');
    fetchFileBlob(file.id, 'preview')
      .then((blob) => {
        if (!alive) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
        setState('ready');
      })
      .catch((e) => {
        if (alive) setState(e instanceof ApiError && e.status === 410 ? 'expired' : 'error');
      });
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file.id, file.expired, isImage, attempt]);

  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setZoom(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoom]);

  const download = () => void downloadFile(file.id, file.name).catch((e) => onError(e instanceof Error ? e.message : 'Téléchargement impossible.'));
  const left = daysLeft(file);
  const hint = left !== null && left <= 7 ? (left === 0 ? "Expire aujourd'hui sur le serveur" : `Expire dans ${left} j sur le serveur`) : null;
  const soft = mine ? 'bg-white/15' : 'bg-mist';

  if (isImage) {
    if (state === 'expired') {
      return (
        <div className={`mb-1 flex w-56 max-w-full flex-col items-center gap-1 rounded-xl px-3 py-6 text-center text-sm ${soft}`}>
          <Icon name="clock" className="h-6 w-6 opacity-80" />
          <span className="font-semibold">Photo expirée</span>
          <span className="text-xs opacity-90">{file.name} n’est plus sur le serveur et n’a pas été ouverte sur cet appareil.</span>
        </div>
      );
    }
    if (state === 'error') {
      return (
        <button onClick={() => setAttempt((n) => n + 1)} className={`mb-1 flex w-56 max-w-full flex-col items-center gap-1 rounded-xl px-3 py-6 text-center text-sm ${soft}`}>
          <span className="font-semibold">Image non chargée</span>
          <span className="text-xs underline">Réessayer</span>
        </button>
      );
    }
    return (
      <div className="mb-1">
        <div className="relative w-64 max-w-full overflow-hidden rounded-xl bg-slate/10 md:w-72">
          {state === 'loading' || !url ? (
            <div className="h-40 w-full animate-pulse" role="status" aria-label={`Chargement de ${file.name}`} />
          ) : (
            <button onClick={() => setZoom(true)} aria-label={`Agrandir ${file.name}`} className="block w-full">
              <img src={url} alt={file.name} className="block max-h-72 min-h-24 w-full object-cover" />
            </button>
          )}
          <button
            onClick={download}
            aria-label={`Télécharger ${file.name}`}
            className="absolute right-2 top-2 inline-flex h-10 w-10 items-center justify-center rounded-full bg-black/60 text-white shadow hover:bg-black/75 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            <Icon name="download" className="h-5 w-5" />
          </button>
        </div>
        {hint && <p className="mt-0.5 text-[11px] opacity-90">{hint}</p>}
        {zoom && url && (
          <div role="dialog" aria-modal="true" aria-label={file.name} className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4" onClick={() => setZoom(false)}>
            <img src={url} alt={file.name} className="max-h-[90vh] max-w-full rounded-lg object-contain" onClick={(e) => e.stopPropagation()} />
            <button autoFocus onClick={() => setZoom(false)} aria-label="Fermer" className="absolute right-4 top-4 inline-flex h-11 w-11 items-center justify-center rounded-full bg-white/15 text-white hover:bg-white/25">
              <Icon name="x" className="h-6 w-6" />
            </button>
            <button onClick={(e) => { e.stopPropagation(); download(); }} aria-label={`Télécharger ${file.name}`} className="absolute right-4 top-20 inline-flex h-11 w-11 items-center justify-center rounded-full bg-white/15 text-white hover:bg-white/25">
              <Icon name="download" className="h-6 w-6" />
            </button>
          </div>
        )}
      </div>
    );
  }

  const unavailable = state === 'expired';
  return (
    <div className="mb-1">
      <button
        onClick={download}
        disabled={unavailable}
        aria-label={unavailable ? `${file.name} (expiré sur le serveur)` : `Télécharger ${file.name}`}
        className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm ${soft} ${unavailable ? 'opacity-70' : mine ? 'hover:bg-white/25' : 'hover:bg-line'}`}
      >
        <Icon name={unavailable ? 'clock' : 'download'} className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{file.name}</span>
        <span className="shrink-0 text-xs opacity-80">{unavailable ? 'Expiré' : formatSize(file.size)}</span>
      </button>
      {unavailable && <p className="mt-0.5 text-[11px] opacity-90">Plus sur le serveur. Demandez à l’auteur de le renvoyer.</p>}
      {!unavailable && hint && <p className="mt-0.5 text-[11px] opacity-90">{hint}</p>}
    </div>
  );
}
