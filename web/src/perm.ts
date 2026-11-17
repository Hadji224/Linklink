import { useAuth } from './auth';
import type { Capability, Fn } from './types';

/** Capacités et fonctions de la personne connectée (le serveur reste seul juge ; ceci masque les boutons inutiles). */
export function useCan() {
  const { user } = useAuth();
  return {
    can: (cap: Capability) => !!user?.can?.[cap],
    hasFn: (fn: Fn) => !!user?.functions?.includes(fn),
    isAdmin: user?.role === 'admin',
    isStaff: user?.role !== 'guest',
  };
}
