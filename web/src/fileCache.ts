/**
 * Copie locale des fichiers sur l'appareil (cache du navigateur), à la manière de WhatsApp :
 * le serveur ne garde les pièces jointes des salons que quelques jours, l'appareil qui les a ouvertes les conserve.
 * Tout est « au mieux » : si le navigateur refuse (navigation privée, espace plein), l'application fonctionne sans.
 */
const CACHE = 'll-files-v1';
const MAX_BYTES = 50 * 1024 * 1024; // au-delà, on ne garde pas de copie
const keyOf = (id: string) => new Request(`${location.origin}/__ll_files/${encodeURIComponent(id)}`);

async function store(): Promise<Cache | null> {
  try {
    return typeof caches === 'undefined' ? null : await caches.open(CACHE);
  } catch {
    return null;
  }
}

export async function getLocalFile(id: string): Promise<Blob | null> {
  try {
    const hit = await (await store())?.match(keyOf(id));
    return hit ? await hit.blob() : null;
  } catch {
    return null;
  }
}

export async function hasLocalFile(id: string): Promise<boolean> {
  try {
    return !!(await (await store())?.match(keyOf(id)));
  } catch {
    return false;
  }
}

export async function saveLocalFile(id: string, blob: Blob): Promise<void> {
  try {
    if (blob.size > MAX_BYTES) return;
    const c = await store();
    if (!c) return;
    await c.put(keyOf(id), new Response(blob, { headers: { 'content-type': blob.type || 'application/octet-stream' } }));
    // Demande au navigateur de ne pas effacer ces copies quand l'espace manque (sans effet s'il refuse).
    void navigator.storage?.persist?.().catch(() => {});
  } catch {
    /* espace insuffisant ou cache indisponible : pas de copie locale */
  }
}

/** À la déconnexion volontaire : on ne laisse pas de fichiers de l'équipe sur un appareil partagé. */
export async function clearLocalFiles(): Promise<void> {
  try {
    if (typeof caches !== 'undefined') await caches.delete(CACHE);
  } catch {
    /* rien à faire */
  }
}
