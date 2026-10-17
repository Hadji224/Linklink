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

/** Date « AAAA-MM-JJ » (échéance) lisible : « Aujourd'hui », « Demain », « 12 oct. 2026 ». */
export function formatDue(date: string) {
  const t = new Date().toISOString().slice(0, 10);
  const tm = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  if (date === t) return "Aujourd'hui";
  if (date === tm) return 'Demain';
  return shortFmt.format(new Date(`${date}T12:00:00`));
}

export const todayStr = () => new Date().toISOString().slice(0, 10);

/** Fichier .ics (agenda) pour un rendez-vous. */
export function icsFor(m: { id: string; title: string; description: string; location: string; startsAt: string }) {
  const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const start = new Date(m.startsAt);
  const end = new Date(start.getTime() + 60 * 60_000);
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (c) => `\\${c}`);
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//LinkLink//FR', 'BEGIN:VEVENT',
    `UID:${m.id}@linklink`, `DTSTAMP:${fmt(new Date())}`, `DTSTART:${fmt(start)}`, `DTEND:${fmt(end)}`,
    `SUMMARY:${esc(m.title)}`, `DESCRIPTION:${esc(m.description)}`, `LOCATION:${esc(m.location)}`,
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
}
