import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';
import { initials } from './format';
import {
  LEVEL_LABEL, PRIORITY_LABEL, ROLE_LABEL, STATUS_LABEL, TASK_STATUS_LABEL,
  type Level, type Priority, type ProjectStatus, type Role, type TaskStatus,
} from './types';

/* --------------------------------- Avatar --------------------------------- */

// Couleurs sombres de la palette étendue (contraste AA avec du texte blanc).
const COLORS = ['#135fea', '#0e4cc0', '#081b4b', '#0b7a8a', '#3b4fb8', '#526079', '#0a6c74', '#2a3f8f'];

export function Avatar({ name, size = 36, online }: { name: string; size?: number; online?: boolean }) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      <span
        className="inline-flex h-full w-full items-center justify-center rounded-full font-semibold text-white"
        style={{ background: COLORS[hash % COLORS.length], fontSize: size * 0.38 }}
        aria-hidden
      >
        {initials(name)}
      </span>
      {online !== undefined && (
        <span
          className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white ${online ? 'bg-emerald-500' : 'bg-slate-300'}`}
          title={online ? 'En ligne' : 'Hors ligne'}
        />
      )}
    </span>
  );
}

/* ------------------------------ Petits éléments ------------------------------ */

export function ErrorNote({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
      {children}
    </p>
  );
}

export function Spinner({ label = 'Chargement…' }: { label?: string }) {
  return (
    <p role="status" className="flex items-center justify-center gap-2 py-8 text-sm text-slate">
      <span className="h-4 w-4 animate-[spin_0.8s_linear_infinite] rounded-full border-2 border-electric border-t-transparent" />
      {label}
    </p>
  );
}

export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="py-10 text-center text-sm text-slate">
      <p>{children}</p>
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function PageHeader({ title, children, back }: { title: string; children?: ReactNode; back?: { href: string; label: string } }) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-white px-4 py-3">
      <div className="min-w-0">
        {back && (
          <a href={back.href} className="text-xs font-semibold text-electric hover:underline">
            ← {back.label}
          </a>
        )}
        <h1 className="truncate text-lg font-bold text-navy">{title}</h1>
      </div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </header>
  );
}

export function ProgressBar({ value, color = '#135fea', label }: { value: number; color?: string; label?: string }) {
  return (
    <div
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label ?? 'Progression'}
      className="h-2 w-full overflow-hidden rounded-full bg-mist ring-1 ring-line"
    >
      <div className="h-full rounded-full transition-all" style={{ width: `${value}%`, background: color }} />
    </div>
  );
}

const CHIP = 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap';

const PROJECT_STATUS_STYLE: Record<ProjectStatus, string> = {
  active: 'bg-emerald-50 text-emerald-800',
  paused: 'bg-amber-50 text-amber-900',
  done: 'bg-blue-50 text-blue-800',
  archived: 'bg-slate-100 text-slate-700',
};
export const StatusChip = ({ status }: { status: ProjectStatus }) => <span className={`${CHIP} ${PROJECT_STATUS_STYLE[status]}`}>{STATUS_LABEL[status]}</span>;

export const PRIORITY_EMOJI: Record<Priority, string> = { urgent: '🔴', high: '🟠', medium: '🟡', low: '🟢' };
const PRIORITY_STYLE: Record<Priority, string> = {
  urgent: 'bg-red-50 text-red-800',
  high: 'bg-orange-50 text-orange-900',
  medium: 'bg-yellow-50 text-yellow-900',
  low: 'bg-emerald-50 text-emerald-800',
};
export const PriorityChip = ({ priority }: { priority: Priority }) => (
  <span className={`${CHIP} ${PRIORITY_STYLE[priority]}`}>
    <span aria-hidden>{PRIORITY_EMOJI[priority]}</span>
    {PRIORITY_LABEL[priority]}
  </span>
);

const TASK_STATUS_STYLE: Record<TaskStatus, string> = {
  todo: 'bg-slate-100 text-slate-800',
  doing: 'bg-blue-50 text-blue-800',
  review: 'bg-violet-50 text-violet-800',
  done: 'bg-emerald-50 text-emerald-800',
};
export const TaskStatusChip = ({ status }: { status: TaskStatus }) => <span className={`${CHIP} ${TASK_STATUS_STYLE[status]}`}>{TASK_STATUS_LABEL[status]}</span>;

const LEVEL_STYLE: Record<Level, string> = {
  public: 'bg-emerald-50 text-emerald-800',
  internal: 'bg-blue-50 text-blue-800',
  confidential: 'bg-amber-50 text-amber-900',
  strict: 'bg-red-50 text-red-800',
};
export const LevelChip = ({ level }: { level: Level }) => (
  <span className={`${CHIP} ${LEVEL_STYLE[level]}`} title={LEVEL_LABEL[level]}>
    {level === 'strict' || level === 'confidential' ? '🔒 ' : ''}
    {level === 'strict' ? 'Strict' : LEVEL_LABEL[level]}
  </span>
);

const ROLE_STYLE: Record<Role, string> = { admin: 'bg-navy text-white', member: 'bg-blue-50 text-blue-800', guest: 'bg-slate-100 text-slate-700' };
export const RoleChip = ({ role }: { role: Role }) => <span className={`${CHIP} ${ROLE_STYLE[role]}`}>{ROLE_LABEL[role]}</span>;

export function Badge({ n, className = '' }: { n: number; className?: string }) {
  if (n <= 0) return null;
  return (
    <span className={`inline-flex min-w-5 items-center justify-center rounded-full bg-cyan px-1.5 text-xs font-bold text-navy ${className}`}>
      {n > 99 ? '99+' : n}
    </span>
  );
}

/* ---------------------------------- Icônes ---------------------------------- */

const PATHS = {
  home: 'M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1v-8Z',
  chat: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z',
  calendar: 'M7 3v3M17 3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z',
  folder: 'M3 7a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z',
  team: 'M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19M10 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM20 19v-1.5a3.5 3.5 0 0 0-2.5-3.35M15 5.2a3 3 0 0 1 0 5.6',
  projects: 'm12 3 9 5-9 5-9-5 9-5ZM3 13l9 5 9-5M3 17.5 12 22l9-4.5',
  tasks: 'M9 11l2 2 4-4M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z',
  bell: 'M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6ZM10 19a2 2 0 0 0 4 0',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 20a8 8 0 0 1 16 0',
  shield: 'M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6l-7-3Zm-3 9 2.2 2.2L15 10',
  attach: 'm20 11-8.2 8.2a5 5 0 0 1-7-7L13 4a3.3 3.3 0 0 1 4.7 4.7l-8.3 8.2a1.7 1.7 0 0 1-2.4-2.4L14.6 7',
  send: 'M5 12 20 4l-5 16-3.5-6.5L5 12Z',
  download: 'M12 4v11m0 0-4-4m4 4 4-4M5 19h14',
  upload: 'M12 16V5m0 0-4 4m4-4 4 4M5 19h14',
  logout: 'M15 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3M10 16l-4-4 4-4M6 12h9',
  plus: 'M12 5v14M5 12h14',
  trash: 'M5 7h14M10 7V5h4v2m-8 0 1 12h10l1-12M10 11v5M14 11v5',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm5-2 5 5',
  x: 'M6 6l12 12M18 6 6 18',
  check: 'm5 12 5 5 9-10',
  chevron: 'm9 6 6 6-6 6',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  kanban: 'M4 4h5v16H4zM10 4h5v10h-5zM16 4h4v13h-4z',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  edit: 'm4 20 4-1 11-11a2.1 2.1 0 0 0-3-3L5 16l-1 4Z',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  clock: 'M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M6 11h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z',
} as const;
export type IconName = keyof typeof PATHS;

export function Icon({ name, className = 'h-5 w-5' }: { name: IconName; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d={PATHS[name]} />
    </svg>
  );
}

/** Logo officiel (charte §3) : image fournie, jamais recomposée. `symbol` = symbole seul (petites tailles, ≥ 32 px). */
export function Logo({ symbol = false, className = 'h-10' }: { symbol?: boolean; className?: string }) {
  return <img src={symbol ? '/logo-symbol.png' : '/logo.png'} alt="LinkLink" className={`w-auto ${className}`} draggable={false} />;
}

/** Icône colorée selon le type de fichier (cahier F-FILE-04). */
export function FileIcon({ name, mime, size = 36 }: { name: string; mime: string; size?: number }) {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  let color = '#526079';
  let label = ext.slice(0, 4).toUpperCase() || 'FILE';
  if (mime === 'application/pdf') color = '#c0392b';
  else if (/word|opendocument\.text|rtf/.test(mime)) color = '#1f5fbf';
  else if (/excel|spreadsheet|csv/.test(mime)) color = '#1e8449';
  else if (/powerpoint|presentation/.test(mime)) color = '#c4571a';
  else if (mime.startsWith('image/')) { color = '#0b7a8a'; label = 'IMG'; }
  else if (mime.startsWith('video/')) { color = '#6c3fb5'; label = 'VID'; }
  else if (mime.startsWith('audio/')) { color = '#6c3fb5'; label = 'AUD'; }
  else if (mime === 'application/zip') color = '#8a6d1d';
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded-lg text-[10px] font-bold text-white" style={{ width: size, height: size, background: color }} aria-hidden>
      {label}
    </span>
  );
}

/* ---------------------------------- Toasts ---------------------------------- */

interface ToastItem { id: number; kind: 'success' | 'error' | 'info'; text: string }
interface ToastApi { success: (t: string) => void; error: (t: string) => void; info: (t: string) => void }
const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const counter = useRef(0);
  const push = useCallback((kind: ToastItem['kind'], text: string) => {
    const id = ++counter.current;
    setItems((l) => [...l.filter((t) => t.kind !== kind).slice(-1), { id, kind, text }]); // un seul message par type, pour ne pas masquer l'écran
    setTimeout(() => setItems((l) => l.filter((t) => t.id !== id)), kind === 'error' ? 6000 : 2800);
  }, []);
  const api = useMemo<ToastApi>(() => ({ success: (t) => push('success', t), error: (t) => push('error', t), info: (t) => push('info', t) }), [push]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-4 md:bottom-6">
        {items.map((t) => (
          <div
            key={t.id}
            role={t.kind === 'error' ? 'alert' : 'status'}
            className={`pointer-events-auto max-w-md animate-[toast-in_0.2s_ease-out] rounded-xl px-4 py-2.5 text-sm font-medium text-white shadow-lg ${
              t.kind === 'error' ? 'bg-[#b42318]' : t.kind === 'success' ? 'bg-navy' : 'bg-electric-dark'
            }`}
          >
            {t.kind === 'success' && '✓ '}
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast doit être utilisé dans <ToastProvider>');
  return ctx;
}

/* ---------------------------- Fenêtre modale / feuille ---------------------------- */

export function Modal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  // onClose est lu via une référence : un re-rendu du parent ne doit ni redonner le focus ni relancer l'effet.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input,textarea,select,button:not([data-close])');
    (first ?? ref.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
      if (e.key === 'Tab' && ref.current) {
        const f = [...ref.current.querySelectorAll<HTMLElement>('a[href],button:not(:disabled),input:not(:disabled),textarea,select,[tabindex]:not([tabindex="-1"])')];
        if (!f.length) return;
        const a = f[0] as HTMLElement, b = f[f.length - 1] as HTMLElement;
        if (e.shiftKey && document.activeElement === a) { e.preventDefault(); b.focus(); }
        else if (!e.shiftKey && document.activeElement === b) { e.preventDefault(); a.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      previous?.focus();
    };
  }, []);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-navy/50 md:items-center md:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`flex max-h-[92dvh] w-full animate-[sheet-in_0.2s_ease-out] flex-col rounded-t-3xl bg-white shadow-2xl md:rounded-3xl ${wide ? 'md:max-w-3xl' : 'md:max-w-lg'}`}
      >
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
          <h2 className="text-lg font-bold">{title}</h2>
          <button data-close onClick={onClose} className="rounded-lg p-2 text-slate hover:bg-mist" aria-label="Fermer">
            <Icon name="x" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}

/* ------------------------------ Confirmation ------------------------------ */

interface ConfirmOptions { title: string; message?: string; confirmLabel?: string; danger?: boolean }
type ConfirmFn = (o: ConfirmOptions) => Promise<boolean>;
const ConfirmContext = createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const confirm = useCallback<ConfirmFn>((o) => new Promise((resolve) => setState({ ...o, resolve })), []);
  const close = (v: boolean) => { state?.resolve(v); setState(null); };
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {state && (
        <Modal title={state.title} onClose={() => close(false)}>
          {state.message && <p className="mb-5 text-sm text-slate">{state.message}</p>}
          <div className="flex justify-end gap-2">
            <button className="btn btn-ghost" onClick={() => close(false)}>Annuler</button>
            <button className={`btn ${state.danger ? 'btn-danger-solid' : 'btn-primary'}`} onClick={() => close(true)}>{state.confirmLabel ?? 'Confirmer'}</button>
          </div>
        </Modal>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const c = useContext(ConfirmContext);
  if (!c) throw new Error('useConfirm doit être utilisé dans <ConfirmProvider>');
  return c;
}

/* ---------------------------------- Onglets ---------------------------------- */

export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: { id: T; label: string; badge?: number }[]; value: T; onChange: (t: T) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 overflow-x-auto border-b border-line bg-white px-3">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={`flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-semibold ${value === t.id ? 'border-electric text-electric' : 'border-transparent text-slate hover:text-navy'}`}
        >
          {t.label}
          {t.badge ? <Badge n={t.badge} /> : null}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <span className="mt-1 block text-xs text-slate">{hint}</span>}
    </label>
  );
}
