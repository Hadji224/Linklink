import { getLocalFile, saveLocalFile } from './fileCache';

const TOKEN_KEY = 'linklink_token';

/** Adresse du serveur quand l'interface est hébergée à part (ex. Vercel → Render). Vide = même origine. */
export const API_BASE = String(import.meta.env.VITE_API_URL ?? '').trim().replace(/\/+$/, '');

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* stockage indisponible : la session ne sera pas conservée */
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn;
}

interface Options {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  form?: FormData;
}

async function rawRequest(path: string, { method = 'GET', body, form }: Options = {}) {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  let payload: BodyInit | undefined;
  if (form) payload = form;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api${path}`, { method, headers, body: payload });
  } catch {
    throw new ApiError(0, 'Impossible de joindre le serveur. Vérifiez votre connexion.');
  }
  // Session glissante : le serveur renvoie un jeton neuf quand le nôtre a plus d'un jour (sauf si on s'est déconnecté entre-temps).
  const refreshed = res.headers.get('x-refreshed-token');
  if (refreshed && token && getToken() === token) setToken(refreshed);
  if (!res.ok) {
    let message = 'Une erreur est survenue.';
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch {
      /* réponse non JSON */
    }
    if (res.status === 401 && token) onUnauthorized?.();
    throw new ApiError(res.status, message);
  }
  return res;
}

export async function api<T>(path: string, options?: Options): Promise<T> {
  const res = await rawRequest(path, options);
  return (await res.json()) as T;
}

/**
 * Contenu d'un fichier : d'abord la copie gardée sur cet appareil, sinon le serveur (avec authentification),
 * puis on garde une copie locale. Un fichier expiré sur le serveur reste donc lisible là où il a déjà été ouvert.
 */
export async function fetchFileBlob(id: string, kind: 'preview' | 'download' = 'download'): Promise<Blob> {
  const local = await getLocalFile(id);
  if (local) return local;
  const blob = await (await rawRequest(`/files/${id}/${kind}`)).blob();
  void saveLocalFile(id, blob);
  return blob;
}

/** Récupère un fichier (aperçu image) en gardant l'authentification ; renvoie une URL d'objet temporaire. */
export async function fetchBlobUrl(path: string): Promise<string> {
  const preview = /^\/files\/([^/]+)\/preview$/.exec(path);
  if (preview) return URL.createObjectURL(await fetchFileBlob(preview[1] as string, 'preview'));
  const res = await rawRequest(path);
  return URL.createObjectURL(await res.blob());
}

/** Télécharge un fichier en conservant l'authentification (en-tête Authorization). */
export async function downloadFile(id: string, name: string) {
  const blob = await fetchFileBlob(id, 'download');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Télécharge le résultat d'une route de l'API (ex. export JSON) sous un nom donné. */
export async function downloadBlob(path: string, name: string) {
  const url = await fetchBlobUrl(path);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
