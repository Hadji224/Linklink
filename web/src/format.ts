const timeFmt = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
const dayYearFmt = new Intl.DateTimeFormat('fr-FR', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});
const shortFmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });

export const formatTime = (iso: string) => timeFmt.format(new Date(iso));
export const formatShortDate = (iso: string) => shortFmt.format(new Date(iso));

export function formatDay(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);
  if (same(d, today)) return "Aujourd'hui";
  if (same(d, yesterday)) return 'Hier';
  if (same(d, tomorrow)) return 'Demain';
  return (d.getFullYear() === today.getFullYear() ? dayFmt : dayYearFmt).format(d);
}

export function formatDateTime(iso: string) {
  return `${formatDay(iso)} à ${formatTime(iso)}`;
}

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} Ko`;
  return `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
}

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '')).toUpperCase();
}

/** Valeur attendue par <input type="datetime-local"> pour une date donnée (heure locale). */
export function toLocalInputValue(d: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
