import type { ReactNode } from 'react';
import { initials } from './format';

const COLORS = [
  'bg-teal-600',
  'bg-amber-600',
  'bg-sky-600',
  'bg-rose-600',
  'bg-violet-600',
  'bg-emerald-600',
  'bg-orange-600',
  'bg-indigo-600',
];

export function Avatar({ name, size = 36 }: { name: string; size?: number }) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white ${COLORS[hash % COLORS.length]}`}
      style={{ width: size, height: size, fontSize: size * 0.38 }}
      aria-hidden
    >
      {initials(name)}
    </span>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
      {children}
    </p>
  );
}

export function Spinner({ label = 'Chargement…' }: { label?: string }) {
  return <p className="py-8 text-center text-sm text-slate-500">{label}</p>;
}

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3">
      <h1 className="text-lg font-bold text-slate-900">{title}</h1>
      {children}
    </header>
  );
}

type IconName = 'chat' | 'calendar' | 'folder' | 'team' | 'attach' | 'send' | 'download' | 'logout' | 'plus' | 'trash';

const PATHS: Record<IconName, string> = {
  chat: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z',
  calendar: 'M7 3v3M17 3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z',
  folder: 'M3 7a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z',
  team: 'M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19M10 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM20 19v-1.5a3.5 3.5 0 0 0-2.5-3.35M15 5.2a3 3 0 0 1 0 5.6',
  attach: 'm20 11-8.2 8.2a5 5 0 0 1-7-7L13 4a3.3 3.3 0 0 1 4.7 4.7l-8.3 8.2a1.7 1.7 0 0 1-2.4-2.4L14.6 7',
  send: 'M5 12 20 4l-5 16-3.5-6.5L5 12Z',
  download: 'M12 4v11m0 0-4-4m4 4 4-4M5 19h14',
  logout: 'M15 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3M10 16l-4-4 4-4M6 12h9',
  plus: 'M12 5v14M5 12h14',
  trash: 'M5 7h14M10 7V5h4v2m-8 0 1 12h10l1-12M10 11v5M14 11v5',
};

export function Icon({ name, className = 'h-5 w-5' }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

export function Logo({ className = 'h-9 w-9' }: { className?: string }) {
  return (
    <svg viewBox="0 0 512 512" className={className} aria-hidden>
      <rect width="512" height="512" rx="112" fill="#0f766e" />
      <g fill="none" stroke="#fef3c7" strokeWidth="44" strokeLinecap="round" strokeLinejoin="round">
        <path d="M215 297a68 68 0 0 0 96 0l70-70a68 68 0 0 0-96-96l-18 18" />
        <path d="M297 215a68 68 0 0 0-96 0l-70 70a68 68 0 0 0 96 96l18-18" />
      </g>
    </svg>
  );
}
