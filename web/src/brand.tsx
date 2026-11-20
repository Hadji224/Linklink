import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, fetchBlobUrl } from './api';

/** Logo personnalisé de la plateforme (public : il s'affiche aussi sur l'écran de connexion). */
interface Brand {
  /** URL d'objet du logo personnalisé, ou null = logo LinkLink d'origine. */
  logoUrl: string | null;
  /** Un logo personnalisé est attendu mais pas encore chargé : on n'affiche pas l'ancien le temps d'un éclair. */
  pending: boolean;
  refresh: () => Promise<void>;
}

const HINT = 'linklink_brand';
const readHint = () => {
  try { return localStorage.getItem(HINT) === 'custom'; } catch { return false; }
};
const writeHint = (custom: boolean) => {
  try { if (custom) localStorage.setItem(HINT, 'custom'); else localStorage.removeItem(HINT); } catch { /* stockage indisponible */ }
};

const BrandContext = createContext<Brand>({ logoUrl: null, pending: false, refresh: async () => {} });
export const useBrand = () => useContext(BrandContext);

export function BrandProvider({ children }: { children: ReactNode }) {
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [hint] = useState(readHint);
  const current = useRef<string | null>(null);

  const swap = useCallback((url: string | null) => {
    if (current.current && current.current !== url) URL.revokeObjectURL(current.current);
    current.current = url;
    setLogoUrl(url);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const info = await api<{ custom: boolean; version: string | null }>('/branding');
      writeHint(info.custom);
      swap(info.custom ? await fetchBlobUrl(`/branding/logo?v=${info.version ?? ''}`) : null);
    } catch {
      /* serveur injoignable ou en veille : on garde ce qui est affiché (logo d'origine par défaut) */
    } finally {
      setChecked(true);
    }
  }, [swap]);

  useEffect(() => { void refresh(); }, [refresh]);

  const value = useMemo(() => ({ logoUrl, pending: !checked && hint, refresh }), [logoUrl, checked, hint, refresh]);
  return <BrandContext.Provider value={value}>{children}</BrandContext.Provider>;
}

const MAX_SIDE = 600;
const MAX_BYTES = 1024 * 1024;

/** Réduit l'image (600 px max) pour rester légère ; refuse ce qui n'est pas une image PNG, JPEG ou WebP. */
export async function prepareLogo(file: File): Promise<File> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('Format non accepté : utilisez une image PNG, JPEG ou WebP.');
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    throw new Error("Cette image n'a pas pu être lue. Essayez un autre fichier.");
  }
  try {
    const ratio = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    if (ratio === 1 && file.size <= MAX_BYTES) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bmp.width * ratio));
    canvas.height = Math.max(1, Math.round(bmp.height * ratio));
    canvas.getContext('2d')?.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const type = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.92));
    if (!blob || blob.size > MAX_BYTES) throw new Error('Logo trop lourd (1 Mo maximum) : choisissez une image plus simple.');
    return new File([blob], file.name.replace(/\.\w+$/, '') + (type === 'image/jpeg' ? '.jpg' : '.png'), { type });
  } finally {
    bmp.close();
  }
}
