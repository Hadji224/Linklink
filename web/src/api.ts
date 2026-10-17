const TOKEN_KEY = 'linklink_token';

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
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
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
    res = await fetch(`/api${path}`, { method, headers, body: payload });
  } catch {
    throw new ApiError(0, 'Impossible de joindre le serveur. Vérifiez votre connexion.');
  }
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

/** Récupère un fichier (aperçu image) en gardant l'authentification ; renvoie une URL d'objet temporaire. */
export async function fetchBlobUrl(path: string): Promise<string> {
  const res = await rawRequest(path);
  return URL.createObjectURL(await res.blob());
}

/** Télécharge un fichier en conservant l'authentification (en-tête Authorization). */
export async function downloadFile(id: string, name: string) {
  const res = await rawRequest(`/files/${id}/download`);
  const blob = await res.blob();
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
