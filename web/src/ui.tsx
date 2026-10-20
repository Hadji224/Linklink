import {
  cloneElement, createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState,
  type ButtonHTMLAttributes, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type ReactNode,
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
    <p role="alert" className="rounded-lg border border-danger/30 bg-danger-bg px-3 py-2 text-sm font-medium text-danger-ink">
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

/* ---------------- D5.4 Squelettes : jamais un spinner seul sur une liste ---------------- */

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden />;
}

/** Reproduit la structure d'une liste de cartes pendant le chargement. */
export function SkeletonList({ rows = 4, label = 'Chargement…' }: { rows?: number; label?: string }) {
  return (
    <div role="status" aria-busy="true" className="space-y-3 p-3">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="card flex items-center gap-3 p-3">
          <Skeleton className="h-10 w-10 shrink-0 !rounded-xl" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5 w-3/5" />
            <Skeleton className="h-3 w-4/5" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** D5.3 : une liste vide n'est pas une erreur — icône, message clair et, si possible, une action. */
export function Empty({ children, action, icon = 'folder', title }: { children: ReactNode; action?: ReactNode; icon?: IconName; title?: string }) {
  return (
    <div className="flex flex-col items-center px-4 py-10 text-center">
      <span className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-electric/10 text-electric" aria-hidden>
        <Icon name={icon} className="h-7 w-7" />
      </span>
      {title && <p className="font-bold text-navy">{title}</p>}
      <p className="mt-1 max-w-sm text-sm text-slate">{children}</p>
      {action && <div className="mt-4">{action}</div>}
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
        <h1 className="t-h1 truncate !text-xl md:!text-2xl">{title}</h1>
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

const CHIP = 'badge';

const PROJECT_STATUS_STYLE: Record<ProjectStatus, string> = {
  active: 'bd-success',
  paused: 'bd-warning',
  done: 'bd-electric',
  archived: 'bd-slate',
};
export const StatusChip = ({ status }: { status: ProjectStatus }) => <span className={`${CHIP} ${PROJECT_STATUS_STYLE[status]}`}>{STATUS_LABEL[status]}</span>;

export const PRIORITY_EMOJI: Record<Priority, string> = { urgent: '🔴', high: '🟠', medium: '🟡', low: '🟢' };
const PRIORITY_STYLE: Record<Priority, string> = { urgent: 'bd-danger', high: 'bd-warning', medium: 'bd-electric', low: 'bd-success' };
/** Couleur d'accent d'une priorité (bord gauche des cartes de tâche, D4.4). */
export const PRIORITY_COLOR: Record<Priority, string> = { urgent: '#ef4444', high: '#f59e0b', medium: '#135fea', low: '#22c55e' };
export const PriorityChip = ({ priority }: { priority: Priority }) => (
  <span className={`${CHIP} ${PRIORITY_STYLE[priority]}`}>
    <span aria-hidden>{PRIORITY_EMOJI[priority]}</span>
    {PRIORITY_LABEL[priority]}
  </span>
);

export const TASK_STATUS_STYLE: Record<TaskStatus, string> = { todo: 'bd-warning', doing: 'bd-electric', review: 'bd-cyan', done: 'bd-success' };
export const TaskStatusChip = ({ status }: { status: TaskStatus }) => <span className={`${CHIP} ${TASK_STATUS_STYLE[status]}`}>{TASK_STATUS_LABEL[status]}</span>;

const LEVEL_STYLE: Record<Level, string> = { public: 'bd-success', internal: 'bd-electric', confidential: 'bd-warning', strict: 'bd-danger' };
export const LevelChip = ({ level }: { level: Level }) => (
  <span className={`${CHIP} ${LEVEL_STYLE[level]}`} title={LEVEL_LABEL[level]}>
    {level === 'strict' || level === 'confidential' ? '🔒 ' : ''}
    {level === 'strict' ? 'Strict' : LEVEL_LABEL[level]}
  </span>
);

const ROLE_STYLE: Record<Role, string> = { admin: 'bd-solid-navy', member: 'bd-navy', guest: 'bd-cyan' };
export const RoleChip = ({ role }: { role: Role }) => <span className={`${CHIP} ${ROLE_STYLE[role]}`}>{ROLE_LABEL[role]}</span>;

/** D4.2 — présence : en ligne / hors ligne (pastille + texte, jamais la couleur seule). */
export const PresenceBadge = ({ online }: { online: boolean }) => (
  <span className={`${CHIP} bd-dot ${online ? 'bd-success' : 'bd-navy'}`}>{online ? 'En ligne' : 'Hors ligne'}</span>
);

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
  archive: 'M4 5h16v4H4zM6 9v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9M10 13h4',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2',
  transfer: 'M7 7h13m-4-4 4 4-4 4M17 17H4m4-4-4 4 4 4',
  sidebar: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1ZM9 5v14',
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
  return <img src={symbol ? '/logo-symbol.png' : '/logo.png'} width={635} height={symbol ? 590 : 770} alt="LinkLink" className={`w-auto ${className}`} draggable={false} />;
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

/* ---------------------------------- Boutons (D4.1, D5.1) ---------------------------------- */

type Variant = 'primary' | 'cyan' | 'ghost' | 'ghost-dark' | 'danger' | 'danger-solid';
const VARIANT_CLASS: Record<Variant, string> = {
  primary: 'btn-primary', cyan: 'btn-cyan', ghost: 'btn-ghost', 'ghost-dark': 'btn-ghost-dark', danger: 'btn-danger', 'danger-solid': 'btn-danger-solid',
};

/** Les 5 états : repos, survol, focus, désactivé, chargement (spinner + « Patientez… »). */
export function Button({
  variant = 'primary', size = 'md', loading = false, loadingLabel = 'Patientez…', className = '', children, disabled, ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg'; loading?: boolean; loadingLabel?: string }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`btn ${VARIANT_CLASS[variant]} ${size === 'sm' ? 'btn-sm' : size === 'lg' ? 'btn-lg' : ''} ${className}`}
    >
      {loading ? loadingLabel : children}
    </button>
  );
}

/* --------------------------------- Case à cocher animée --------------------------------- */

export function CheckBox({ checked, onChange, disabled, label, id }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string; id?: string }) {
  return (
    <span className="cb">
      <input type="checkbox" id={id} checked={checked} disabled={disabled} aria-label={label} onChange={(e) => onChange(e.target.checked)} />
      <span className="cb-box" aria-hidden>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
          <path className="cb-tick" d="m5 12.5 4.5 4.5L19 7.5" />
        </svg>
      </span>
    </span>
  );
}

/* ----------------------------------- Info-bulle ----------------------------------- */

export function Tooltip({ label, children, below = false }: { label: string; children: ReactElement<{ 'aria-describedby'?: string }>; below?: boolean }) {
  const id = useId();
  return (
    <span className={`tt ${below ? 'tt-below' : ''}`}>
      {cloneElement(children, { 'aria-describedby': id })}
      <span role="tooltip" id={id} className="tt-bubble">{label}</span>
    </span>
  );
}

/* ------------------------------- Pile d'avatars ------------------------------- */

export function AvatarStack({ names, max = 4, size = 28 }: { names: string[]; max?: number; size?: number }) {
  const shown = names.slice(0, max);
  const extra = names.length - shown.length;
  return (
    <span className="inline-flex items-center" role="img" aria-label={`${names.length} membre${names.length > 1 ? 's' : ''} : ${names.join(', ')}`}>
      {shown.map((n, i) => (
        <span key={`${n}-${i}`} className="rounded-full ring-2 ring-white" style={{ marginLeft: i ? -size * 0.3 : 0 }}>
          <Avatar name={n} size={size} />
        </span>
      ))}
      {extra > 0 && (
        <span className="inline-flex items-center justify-center rounded-full bg-cloud-deep text-[11px] font-bold text-navy ring-2 ring-white" style={{ marginLeft: -size * 0.3, width: size, height: size }} aria-hidden>
          +{extra}
        </span>
      )}
    </span>
  );
}

/* ---------------------------------- Toasts (D5.2, D6.1) ---------------------------------- */

interface ToastItem { id: number; kind: 'success' | 'error' | 'info'; text: string; leaving?: boolean }
interface ToastApi { success: (t: string) => void; error: (t: string) => void; info: (t: string) => void }
const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const counter = useRef(0);
  const push = useCallback((kind: ToastItem['kind'], text: string) => {
    const id = ++counter.current;
    setItems((l) => [...l.filter((t) => t.kind !== kind).slice(-1), { id, kind, text }]); // un seul message par type, pour ne pas masquer l'écran
    // Disparition automatique : 3 s (6 s pour une erreur), sortie en 150 ms.
    setTimeout(() => setItems((l) => l.map((t) => (t.id === id ? { ...t, leaving: true } : t))), kind === 'error' ? 6000 : 3000);
    setTimeout(() => setItems((l) => l.filter((t) => t.id !== id)), kind === 'error' ? 6150 : 3150);
  }, []);
  const api = useMemo<ToastApi>(() => ({ success: (t) => push('success', t), error: (t) => push('error', t), info: (t) => push('info', t) }), [push]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-4 sm:inset-x-auto sm:bottom-6 sm:right-6 sm:items-end sm:px-0">
        {items.map((t) => (
          <div
            key={t.id}
            role={t.kind === 'error' ? 'alert' : 'status'}
            style={{ animation: `${t.leaving ? 'toast-out 150ms' : 'toast-in 200ms'} var(--ease-out) forwards` }}
            className={`pointer-events-auto max-w-md rounded-xl px-4 py-2.5 text-sm font-medium text-white shadow-lg ${
              t.kind === 'error' ? 'bg-[#b91c1c]' : t.kind === 'success' ? 'bg-success-ink' : 'bg-electric-deep'
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

/* ------------------- Fenêtre modale, panneau latéral : comportement commun ------------------- */

// Pile de fenêtres ouvertes : seule celle du dessus réagit à Échap et à Tab (une confirmation au-dessus d'un panneau, par exemple).
const dialogStack: symbol[] = [];

function useDialog(ref: React.RefObject<HTMLDivElement | null>, onClose: () => void) {
  // onClose est lu via une référence : un re-rendu du parent ne doit ni redonner le focus ni relancer l'effet.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const me = Symbol('dialog');
    dialogStack.push(me);
    const previous = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input:not(:disabled),textarea:not(:disabled),select:not(:disabled),button:not([data-close]):not(:disabled)');
    (first ?? ref.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (dialogStack[dialogStack.length - 1] !== me) return;
      if (e.key === 'Escape') closeRef.current();
      if (e.key === 'Tab' && ref.current) {
        const f = [...ref.current.querySelectorAll<HTMLElement>('a[href],button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex]:not([tabindex="-1"])')];
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
      dialogStack.splice(dialogStack.indexOf(me), 1);
      if (!dialogStack.length) document.body.style.overflow = '';
      previous?.focus();
    };
  }, [ref]);
}

export function Modal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useDialog(ref, onClose);
  return (
    <div className="backdrop fixed inset-0 z-50 flex items-end justify-center md:items-center md:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`sheet flex max-h-[92dvh] w-full flex-col rounded-t-3xl bg-white md:rounded-3xl ${wide ? 'md:max-w-3xl' : 'md:max-w-lg'}`}
      >
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
          <h2 className="t-h4">{title}</h2>
          <button data-close onClick={onClose} className="icon-btn" aria-label="Fermer">
            <Icon name="x" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}

/** D4.5 — panneau latéral coulissant : consulter ou modifier un élément sans quitter la page. */
export function Drawer({ title, onClose, children, actions, subtitle }: { title: string; onClose: () => void; children: ReactNode; actions?: ReactNode; subtitle?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useDialog(ref, onClose);
  return (
    <div className="backdrop fixed inset-0 z-50 flex justify-end" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="drawer flex h-full w-full flex-col bg-white sm:max-w-xl sm:rounded-l-3xl lg:max-w-2xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-3">
          <div className="min-w-0">
            <h2 className="t-h4 truncate">{title}</h2>
            {subtitle && <div className="mt-0.5 text-sm text-slate">{subtitle}</div>}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {actions}
            <button data-close onClick={onClose} className="icon-btn" aria-label="Fermer le panneau">
              <Icon name="x" />
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}

/* -------------------------------- Menu déroulant (D4.5) -------------------------------- */

export interface MenuItem { label: string; icon?: IconName; onSelect: () => void; danger?: boolean; disabled?: boolean }

export function Menu({ label, items, icon = 'more' }: { label: string; items: MenuItem[]; icon?: IconName }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const away = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  const close = (refocus = true) => { setOpen(false); if (refocus) trigger.current?.focus(); };
  const onKey = (e: ReactKeyboardEvent) => {
    const list = [...(panel.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    const at = list.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => { e.preventDefault(); list[(i + list.length) % list.length]?.focus(); };
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(list.length - 1);
    else if (e.key === 'Escape') { e.stopPropagation(); close(); }
    else if (e.key === 'Tab') close(false);
  };
  return (
    <span ref={root} className="relative inline-flex">
      <button
        ref={trigger}
        className="icon-btn"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); setOpen(true); } }}
      >
        <Icon name={icon} />
      </button>
      {open && (
        <div ref={panel} id={id} role="menu" aria-label={label} className="menu-panel" onKeyDown={onKey}>
          {items.map((it) => (
            <button
              key={it.label}
              role="menuitem"
              disabled={it.disabled}
              className={`menu-item ${it.danger ? 'menu-item-danger' : ''}`}
              onClick={() => { close(false); it.onSelect(); }}
            >
              {it.icon && <Icon name={it.icon} className="h-4 w-4" />}
              {it.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/* ------------------------------ Confirmation (D5.2 : action irréversible) ------------------------------ */

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
          className={`flex min-h-11 shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-semibold transition-colors ${value === t.id ? 'border-electric text-electric' : 'border-transparent text-slate hover:text-navy'}`}
        >
          {t.label}
          {t.badge ? <Badge n={t.badge} /> : null}
        </button>
      ))}
    </div>
  );
}

/** Étiquette toujours visible (jamais de placeholder seul). `error` : message sous le champ, lu par les lecteurs d'écran. */
export function Field({ label, children, hint, error }: { label: string; children: ReactNode; hint?: string; error?: string }) {
  return (
    <label className="block">
      <span className={`label ${error ? 'label-error' : ''}`}>{label}</span>
      <div className="mt-1">{children}</div>
      {error ? <span role="alert" className="mt-1 block text-xs font-medium text-danger-ink">{error}</span> : hint && <span className="mt-1 block text-xs text-slate">{hint}</span>}
    </label>
  );
}
