import { useEffect, useState } from 'react';

/** Navigation par hash (#projets/abc/taches/def) : segments de l'adresse courante. */
export const readRoute = () => location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);

export function useRoute(): string[] {
  const [route, setRoute] = useState(readRoute);
  useEffect(() => {
    const on = () => setRoute(readRoute());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export const go = (path: string) => {
  location.hash = path;
};
