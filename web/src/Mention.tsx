import { useRef, useState } from 'react';
import { useAuth } from './auth';
import { useApp } from './data';
import { Avatar } from './ui';

/** Zone de texte avec suggestions @prénom (commentaires de tâches). */
export function MentionTextarea({ value, onChange, placeholder, rows = 2, label }: { value: string; onChange: (v: string) => void; placeholder?: string; rows?: number; label: string }) {
  const { members } = useApp();
  const { user } = useAuth();
  const [suggest, setSuggest] = useState<string[]>([]);
  const ref = useRef<HTMLTextAreaElement>(null);

  function change(v: string, caret: number) {
    onChange(v);
    const m = /@([\p{L}\p{N}' -]{0,30})$/u.exec(v.slice(0, caret));
    if (!m) return setSuggest([]);
    const q = (m[1] ?? '').toLowerCase();
    setSuggest(members.filter((x) => x.id !== user?.id && x.name.toLowerCase().includes(q)).slice(0, 5).map((x) => x.name));
  }
  function pick(name: string) {
    const caret = ref.current?.selectionStart ?? value.length;
    onChange(value.slice(0, caret).replace(/@([\p{L}\p{N}' -]{0,30})$/u, `@${name} `) + value.slice(caret));
    setSuggest([]);
    ref.current?.focus();
  }
  return (
    <div className="relative">
      {suggest.length > 0 && (
        <ul role="listbox" aria-label="Mentionner" className="absolute inset-x-0 bottom-full z-10 mb-1 overflow-hidden rounded-xl border border-line bg-white shadow-lg">
          {suggest.map((n) => (
            <li key={n} role="presentation">
              <button type="button" role="option" aria-selected={false} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-mist" onMouseDown={(e) => { e.preventDefault(); pick(n); }}>
                <Avatar name={n} size={24} /> {n}
              </button>
            </li>
          ))}
        </ul>
      )}
      <textarea ref={ref} aria-label={label} className="field" rows={rows} value={value} placeholder={placeholder} maxLength={3000} onChange={(e) => change(e.target.value, e.target.selectionStart)} onKeyDown={(e) => e.key === 'Escape' && setSuggest([])} />
    </div>
  );
}
