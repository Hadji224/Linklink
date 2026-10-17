import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { api, downloadFile } from '../api';
import { useAuth } from '../auth';
import { useApp } from '../data';
import { formatDay, formatSize, formatTime } from '../format';
import { useRealtime, useRealtimeEvents } from '../realtime';
import type { Channel, Message } from '../types';
import { Avatar, Badge, Empty, ErrorNote, Field, Icon, Modal, useToast } from '../ui';

const URL_RE = /(https?:\/\/[^\s<>"']+)/g;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Liens cliquables et @mentions en surbrillance ; tout le reste reste du texte (aucun HTML injecté). */
function renderBody(text: string, names: string[], mine: boolean): ReactNode[] {
  const mentionRe = names.length ? new RegExp(`(@(?:${names.sort((a, b) => b.length - a.length).map(escapeRe).join('|')}))`, 'giu') : null;
  return text.split(URL_RE).flatMap((part, i) => {
    if (i % 2 === 1) {
      return [
        <a key={`u${i}`} href={part} target="_blank" rel="noopener noreferrer" className="break-all underline">
          {part}
        </a>,
      ];
    }
    if (!mentionRe) return [<Fragment key={`t${i}`}>{part}</Fragment>];
    return part.split(mentionRe).map((seg, j) =>
      j % 2 === 1 ? (
        <strong key={`m${i}-${j}`} className={`rounded px-0.5 ${mine ? 'bg-white/20' : 'bg-blue-50 text-electric'}`}>
          {seg}
        </strong>
      ) : (
        <Fragment key={`t${i}-${j}`}>{seg}</Fragment>
      ),
    );
  });
}

export function channelLabel(c: Channel) {
  return c.kind === 'dm' ? c.name : `# ${c.name}`;
}

interface PanelProps {
  channelId: string;
  active: boolean;
  onBack?: () => void;
}

/** Fil de discussion d'un salon (utilisé par l'écran Messages et par l'onglet Messages d'un projet). */
export function ChatPanel({ channelId, active, onBack }: PanelProps) {
  const { user } = useAuth();
  const { epoch } = useRealtime();
  const { channels, members, setOpenChannel } = useApp();
  const toast = useToast();
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [suggest, setSuggest] = useState<string[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  const channel = channels.find((c) => c.id === channelId) ?? null;
  const canWrite = !!channel && (!channel.adminOnly || user?.role === 'admin');
  const names = useMemo(() => members.map((m) => m.name), [members]);
  const currentId = useRef(channelId);
  currentId.current = channelId;

  const load = useCallback(async (id: string) => {
    setLoading(true);
    try {
      const r = await api<{ messages: Message[]; hasMore: boolean }>(`/channels/${id}/messages`);
      if (currentId.current !== id) return;
      stickToBottom.current = true;
      setMessages(r.messages);
      setHasMore(r.hasMore);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Chargement impossible.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setMessages([]);
    setDraft('');
    void load(channelId);
  }, [channelId, load, epoch]);

  // Le salon ouvert est « lu » tant qu'il est affiché.
  useEffect(() => {
    if (active) setOpenChannel(channelId);
    return () => setOpenChannel(null);
  }, [active, channelId, setOpenChannel]);

  useRealtimeEvents((event) => {
    if (event.type !== 'message' || event.message.channelId !== currentId.current) return;
    const m = event.message;
    setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
    if (m.user.id === user?.id) stickToBottom.current = true;
  });

  useEffect(() => {
    const el = scroller.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, active]);

  async function loadOlder() {
    const first = messages[0];
    if (!first) return;
    const el = scroller.current;
    const prevHeight = el?.scrollHeight ?? 0;
    const r = await api<{ messages: Message[]; hasMore: boolean }>(`/channels/${channelId}/messages?before=${encodeURIComponent(first.createdAt)}`);
    stickToBottom.current = false;
    setMessages((prev) => [...r.messages, ...prev]);
    setHasMore(r.hasMore);
    requestAnimationFrame(() => {
      if (el) el.scrollTop = el.scrollHeight - prevHeight;
    });
  }

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setError('');
    try {
      const r = await api<{ message: Message }>(`/channels/${channelId}/messages`, { method: 'POST', body: { body } });
      stickToBottom.current = true;
      setMessages((prev) => (prev.some((x) => x.id === r.message.id) ? prev : [...prev, r.message]));
      setDraft('');
      setSuggest([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Envoi impossible.');
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Escape') setSuggest([]);
    // Téléphone : Entrée = retour à la ligne. Ordinateur : Entrée envoie (Maj+Entrée = retour à la ligne).
    const touch = window.matchMedia('(pointer: coarse)').matches;
    if (e.key === 'Enter' && !e.shiftKey && !touch) {
      e.preventDefault();
      void send();
    }
  }

  function onChange(value: string, caret: number) {
    setDraft(value);
    const m = /@([\p{L}\p{N}' -]{0,30})$/u.exec(value.slice(0, caret));
    if (!m) return setSuggest([]);
    const q = (m[1] ?? '').toLowerCase();
    setSuggest(members.filter((x) => x.id !== user?.id && x.name.toLowerCase().includes(q)).slice(0, 5).map((x) => x.name));
  }

  function pickMention(name: string) {
    const el = area.current;
    const caret = el?.selectionStart ?? draft.length;
    const before = draft.slice(0, caret).replace(/@([\p{L}\p{N}' -]{0,30})$/u, `@${name} `);
    setDraft(before + draft.slice(caret));
    setSuggest([]);
    el?.focus();
  }

  async function attach(file: File | undefined) {
    if (!file) return;
    setSending(true);
    setError('');
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('channelId', channelId);
      if (draft.trim()) form.append('caption', draft.trim());
      const r = await api<{ message: Message | null }>('/files', { method: 'POST', form });
      if (r.message) {
        const message = r.message;
        stickToBottom.current = true;
        setMessages((prev) => (prev.some((x) => x.id === message.id) ? prev : [...prev, message]));
      }
      setDraft('');
      toast.success('Fichier envoyé');
    } catch (err) {
      setError(err instanceof Error ? err.message : "Envoi du fichier impossible.");
    } finally {
      setSending(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col" aria-label={channel ? channelLabel(channel) : 'Discussion'}>
      {channel && (
        <div className="flex items-center gap-2 border-b border-line bg-white px-3 py-2">
          {onBack && (
            <button onClick={onBack} className="rounded-lg p-2 text-electric hover:bg-mist md:hidden" aria-label="Retour aux salons">
              <span aria-hidden>←</span>
            </button>
          )}
          {channel.kind === 'dm' && <Avatar name={channel.name} size={30} online={members.find((m) => m.id === channel.peer?.id)?.online} />}
          <div className="min-w-0">
            <h2 className="truncate font-bold">{channelLabel(channel)}</h2>
            {channel.description && channel.kind !== 'dm' && <p className="truncate text-xs text-slate">{channel.description}</p>}
          </div>
        </div>
      )}

      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 py-3"
        role="log"
        aria-live="polite"
      >
        {hasMore && (
          <div className="text-center">
            <button className="btn btn-ghost btn-sm" onClick={() => void loadOlder()}>
              Messages précédents
            </button>
          </div>
        )}
        {loading && messages.length === 0 && <p className="py-8 text-center text-sm text-slate">Chargement…</p>}
        {!loading && messages.length === 0 && !error && <Empty>Aucun message pour l'instant. Lancez la discussion !</Empty>}
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
          const mine = m.user.id === user?.id;
          // Regroupement des messages consécutifs d'un même auteur (cahier F-MSG-02).
          const grouped = !newDay && prev?.user.id === m.user.id && +new Date(m.createdAt) - +new Date(prev.createdAt) < 5 * 60_000;
          return (
            <Fragment key={m.id}>
              {newDay && (
                <div className="py-2 text-center">
                  <span className="rounded-full bg-white px-3 py-0.5 text-xs font-semibold text-slate ring-1 ring-line">{formatDay(m.createdAt)}</span>
                </div>
              )}
              <div className={`flex items-end gap-2 ${mine ? 'flex-row-reverse' : ''} ${grouped ? '' : 'mt-2'}`}>
                {!mine && (grouped ? <span className="w-8 shrink-0" /> : <Avatar name={m.user.name} size={32} />)}
                <div
                  className={`max-w-[82%] rounded-2xl px-3 py-2 text-[15px] leading-snug shadow-sm md:max-w-[70%] ${
                    mine ? 'rounded-br-md bg-electric text-white' : 'rounded-bl-md bg-white text-navy ring-1 ring-line'
                  }`}
                >
                  {!mine && !grouped && <p className="mb-0.5 text-xs font-bold text-electric">{m.user.name}</p>}
                  {m.file && (
                    <button
                      onClick={() => m.file && void downloadFile(m.file.id, m.file.name)}
                      aria-label={`Télécharger ${m.file.name}`}
                      className={`mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm ${mine ? 'bg-white/15 hover:bg-white/25' : 'bg-mist hover:bg-line'}`}
                    >
                      <Icon name="download" className="h-4 w-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{m.file.name}</span>
                      <span className="shrink-0 text-xs opacity-80">{formatSize(m.file.size)}</span>
                    </button>
                  )}
                  {m.body && <p className="whitespace-pre-wrap break-words">{renderBody(m.body, [...names], mine)}</p>}
                  <p className={`mt-0.5 text-right text-[11px] ${mine ? 'text-white' : 'text-slate'}`}>{formatTime(m.createdAt)}</p>
                </div>
              </div>
            </Fragment>
          );
        })}
      </div>

      <div className="relative border-t border-line bg-white p-2">
        <ErrorNote>{error}</ErrorNote>
        {channel && !canWrite ? (
          <p className="px-2 py-3 text-center text-sm text-slate">Seul le Super Admin peut écrire dans ce salon.</p>
        ) : (
          <>
            {suggest.length > 0 && (
              <ul role="listbox" aria-label="Mentionner" className="absolute inset-x-2 bottom-full mb-1 overflow-hidden rounded-xl border border-line bg-white shadow-lg">
                {suggest.map((n) => (
                  <li key={n} role="presentation">
                    <button type="button" role="option" aria-selected={false} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-mist" onMouseDown={(e) => { e.preventDefault(); pickMention(n); }}>
                      <Avatar name={n} size={24} /> {n}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <form onSubmit={send} className="flex items-end gap-2">
              <input ref={fileInput} type="file" className="hidden" onChange={(e) => void attach(e.target.files?.[0])} aria-label="Choisir un fichier" />
              <button type="button" className="btn btn-ghost !px-2.5" onClick={() => fileInput.current?.click()} disabled={sending || !channel} aria-label="Joindre un fichier">
                <Icon name="attach" />
              </button>
              <textarea
                ref={area}
                value={draft}
                onChange={(e) => onChange(e.target.value, e.target.selectionStart)}
                onKeyDown={onKeyDown}
                rows={1}
                maxLength={4000}
                placeholder={channel ? `Écrire dans ${channelLabel(channel)} — @ pour mentionner` : 'Message'}
                aria-label="Votre message"
                className="field max-h-32 min-h-[44px] flex-1 resize-none"
                disabled={!channel}
              />
              <button className="btn btn-primary !px-3" disabled={sending || !draft.trim()} aria-label="Envoyer">
                <Icon name="send" />
              </button>
            </form>
          </>
        )}
      </div>
    </section>
  );
}

function ChannelButton({ c, selected, onClick }: { c: Channel; selected: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-current={selected}
      className={`flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2.5 text-left text-sm font-semibold ${selected ? 'bg-electric text-white' : 'text-navy hover:bg-mist'}`}
    >
      <span className="min-w-0 truncate">{channelLabel(c)}</span>
      <Badge n={c.unread} />
    </button>
  );
}

export function Chat({ active }: { active: boolean }) {
  const { user } = useAuth();
  const { channels, members, refreshChannels } = useApp();
  const [channelId, setChannelId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newDm, setNewDm] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();

  // Ordinateur : on ouvre #général d'office. Téléphone : on montre d'abord la liste des salons.
  useEffect(() => {
    if (channelId || !channels.length) return;
    if (window.matchMedia('(min-width: 768px)').matches) setChannelId(channels.find((c) => c.name === 'général')?.id ?? channels[0]?.id ?? null);
  }, [channels, channelId]);

  useEffect(() => {
    if (channelId && channels.length && !channels.some((c) => c.id === channelId)) setChannelId(null);
  }, [channels, channelId]);

  const salons = channels.filter((c) => c.kind === 'channel').sort((a, b) => Number(b.adminOnly) - Number(a.adminOnly) || a.name.localeCompare(b.name));
  const projets = channels.filter((c) => c.kind === 'project');
  const dms = channels.filter((c) => c.kind === 'dm');

  async function createChannel(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    try {
      const r = await api<{ channel: Channel }>('/channels', {
        method: 'POST',
        body: { name: String(form.get('name') ?? ''), description: String(form.get('description') ?? '') },
      });
      setCreating(false);
      await refreshChannels();
      setChannelId(r.channel.id);
      toast.success(`Salon #${r.channel.name} créé`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Création impossible.');
    }
  }

  async function openDm(userId: string) {
    try {
      const r = await api<{ channel: Channel }>('/dms', { method: 'POST', body: { userId } });
      await refreshChannels();
      setChannelId(r.channel.id);
      setNewDm(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Impossible de démarrer la conversation.');
    }
  }

  // Ouverture directe d'une conversation depuis l'onglet Équipe (#messages/dm/<id>).
  useEffect(() => {
    const on = () => {
      const m = /^#messages\/dm\/(.+)$/.exec(location.hash);
      if (m && m[1]) {
        void openDm(m[1]);
        history.replaceState(null, '', '#messages');
      }
    };
    on();
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex h-full min-h-0 md:flex-row">
      <nav aria-label="Salons et conversations" className={`min-h-0 flex-col overflow-y-auto border-line bg-white p-3 md:flex md:w-64 md:shrink-0 md:border-r ${channelId ? 'hidden' : 'flex flex-1'}`}>
        <h1 className="px-2 pb-2 text-lg font-bold md:hidden">Messages</h1>
        <p className="px-2 pb-1 text-xs font-bold uppercase tracking-wide text-slate">Salons</p>
        {salons.map((c) => <ChannelButton key={c.id} c={c} selected={c.id === channelId} onClick={() => setChannelId(c.id)} />)}
        {user?.role === 'admin' && (
          <button onClick={() => setCreating(true)} className="mt-1 flex items-center gap-1 rounded-xl border border-dashed border-line px-3 py-2 text-sm font-semibold text-slate hover:bg-mist">
            <Icon name="plus" className="h-4 w-4" /> Nouveau salon
          </button>
        )}
        {projets.length > 0 && (
          <>
            <p className="mt-4 px-2 pb-1 text-xs font-bold uppercase tracking-wide text-slate">Projets</p>
            {projets.map((c) => <ChannelButton key={c.id} c={c} selected={c.id === channelId} onClick={() => setChannelId(c.id)} />)}
          </>
        )}
        <p className="mt-4 px-2 pb-1 text-xs font-bold uppercase tracking-wide text-slate">Messages directs</p>
        {dms.map((c) => <ChannelButton key={c.id} c={c} selected={c.id === channelId} onClick={() => setChannelId(c.id)} />)}
        <button onClick={() => setNewDm(true)} className="mt-1 flex items-center gap-1 rounded-xl border border-dashed border-line px-3 py-2 text-sm font-semibold text-slate hover:bg-mist">
          <Icon name="plus" className="h-4 w-4" /> Nouvelle conversation
        </button>
      </nav>

      <div className={`min-h-0 min-w-0 flex-1 ${channelId ? 'flex' : 'hidden md:flex'}`}>
        {channelId ? (
          <ChatPanel key={channelId} channelId={channelId} active={active} onBack={() => setChannelId(null)} />
        ) : (
          <Empty>Choisissez un salon ou une conversation.</Empty>
        )}
      </div>

      {creating && (
        <Modal title="Nouveau salon" onClose={() => setCreating(false)}>
          <form onSubmit={createChannel} className="space-y-3">
            <Field label="Nom du salon" hint="Lettres, chiffres et tirets.">
              <input name="name" className="field" placeholder="ex. technique" required minLength={2} maxLength={30} />
            </Field>
            <Field label="Description (facultatif)">
              <input name="description" className="field" maxLength={200} />
            </Field>
            <ErrorNote>{error}</ErrorNote>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn btn-ghost" onClick={() => setCreating(false)}>Annuler</button>
              <button className="btn btn-primary">Créer</button>
            </div>
          </form>
        </Modal>
      )}
      {newDm && (
        <Modal title="Nouvelle conversation" onClose={() => setNewDm(false)}>
          <ul className="space-y-1">
            {members.filter((m) => m.id !== user?.id).map((m) => (
              <li key={m.id}>
                <button onClick={() => void openDm(m.id)} className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-mist">
                  <Avatar name={m.name} size={36} online={m.online} />
                  <span className="font-semibold">{m.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </div>
  );
}
