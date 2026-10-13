import { Fragment, useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { api, downloadFile } from '../api';
import { useAuth } from '../auth';
import { formatDay, formatSize, formatTime } from '../format';
import { useRealtime, useRealtimeEvents } from '../realtime';
import type { Channel, Message } from '../types';
import { Avatar, ErrorNote, Icon } from '../ui';

const URL_RE = /(https?:\/\/[^\s<>"']+)/g;

/** Rend les liens http(s) cliquables ; le reste du texte reste du texte (pas de HTML injecté). */
function linkify(text: string): ReactNode[] {
  return text.split(URL_RE).map((part, i) =>
    i % 2 === 1 ? (
      <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="underline break-all">
        {part}
      </a>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

interface Props {
  active: boolean;
  onUnreadChange: (total: number) => void;
}

export function Chat({ active, onUnreadChange }: Props) {
  const { user } = useAuth();
  const { epoch } = useRealtime();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const fileInput = useRef<HTMLInputElement>(null);

  const channel = channels.find((c) => c.id === channelId) ?? null;
  const canWrite = !!channel && (!channel.adminOnly || user?.role === 'admin');

  // Refs pour que l'écouteur temps réel voie toujours les valeurs à jour.
  const state = useRef({ channelId, active });
  state.current = { channelId, active };

  const loadChannels = useCallback(async () => {
    const r = await api<{ channels: Channel[] }>('/channels');
    setChannels(r.channels);
    setChannelId((current) => current ?? r.channels.find((c) => c.name === 'général')?.id ?? r.channels[0]?.id ?? null);
  }, []);

  const loadMessages = useCallback(async (id: string) => {
    setLoading(true);
    try {
      const r = await api<{ messages: Message[]; hasMore: boolean }>(`/channels/${id}/messages`);
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

  // (Re)chargement à la connexion et après chaque reconnexion du temps réel.
  useEffect(() => {
    loadChannels().catch((e) => setError(e instanceof Error ? e.message : 'Chargement impossible.'));
  }, [loadChannels, epoch]);

  useEffect(() => {
    if (channelId) {
      void loadMessages(channelId);
      setUnread((u) => (u[channelId] ? { ...u, [channelId]: 0 } : u));
    }
  }, [channelId, loadMessages, epoch]);

  useRealtimeEvents((event) => {
    if (event.type !== 'message') return;
    const m = event.message;
    const { channelId: current, active: visible } = state.current;
    if (m.channelId === current) {
      setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
      if (m.user.id === user?.id) stickToBottom.current = true;
    }
    if (m.user.id !== user?.id && (m.channelId !== current || !visible || document.hidden)) {
      setUnread((u) => ({ ...u, [m.channelId]: (u[m.channelId] ?? 0) + 1 }));
    }
  });

  // Quand on revient sur l'onglet Messages, le salon ouvert est considéré comme lu.
  useEffect(() => {
    if (active && channelId) setUnread((u) => (u[channelId] ? { ...u, [channelId]: 0 } : u));
  }, [active, channelId]);

  useEffect(() => {
    onUnreadChange(Object.values(unread).reduce((a, b) => a + b, 0));
  }, [unread, onUnreadChange]);

  useEffect(() => {
    const el = scroller.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, active]);

  async function loadOlder() {
    const first = messages[0];
    if (!channelId || !first) return;
    const el = scroller.current;
    const prevHeight = el?.scrollHeight ?? 0;
    const r = await api<{ messages: Message[]; hasMore: boolean }>(
      `/channels/${channelId}/messages?before=${encodeURIComponent(first.createdAt)}`,
    );
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
    if (!body || !channelId || sending) return;
    setSending(true);
    setError('');
    try {
      const r = await api<{ message: Message }>(`/channels/${channelId}/messages`, { method: 'POST', body: { body } });
      stickToBottom.current = true;
      setMessages((prev) => (prev.some((x) => x.id === r.message.id) ? prev : [...prev, r.message]));
      setDraft('');
    } catch (err) {
      setError(err instanceof Error ? err.message : "Envoi impossible.");
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Sur téléphone, Entrée = retour à la ligne ; sur ordinateur, Entrée envoie (Maj+Entrée = retour à la ligne).
    const touch = window.matchMedia('(pointer: coarse)').matches;
    if (e.key === 'Enter' && !e.shiftKey && !touch) {
      e.preventDefault();
      void send();
    }
  }

  async function attach(file: File | undefined) {
    if (!file || !channelId) return;
    setSending(true);
    setError('');
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('folder', 'Messages');
      form.append('channelId', channelId);
      if (draft.trim()) form.append('caption', draft.trim());
      const r = await api<{ message: Message | null }>('/files', { method: 'POST', form });
      if (r.message) {
        const message = r.message;
        stickToBottom.current = true;
        setMessages((prev) => (prev.some((x) => x.id === message.id) ? prev : [...prev, message]));
      }
      setDraft('');
    } catch (err) {
      setError(err instanceof Error ? err.message : "Envoi du fichier impossible.");
    } finally {
      setSending(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function createChannel(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    try {
      const r = await api<{ channel: Channel }>('/channels', {
        method: 'POST',
        body: { name: String(form.get('name') ?? ''), description: String(form.get('description') ?? '') },
      });
      setCreating(false);
      await loadChannels();
      setChannelId(r.channel.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Création impossible.');
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      {/* Salons : liste verticale sur ordinateur, bandeau défilant sur téléphone */}
      <nav
        aria-label="Salons"
        className="flex shrink-0 gap-2 overflow-x-auto border-b border-slate-200 bg-white px-3 py-2 md:w-60 md:flex-col md:gap-1 md:overflow-y-auto md:border-b-0 md:border-r md:p-3"
      >
        <p className="hidden px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-slate-400 md:block">Salons</p>
        {channels.map((c) => (
          <button
            key={c.id}
            onClick={() => setChannelId(c.id)}
            aria-current={c.id === channelId}
            className={`flex shrink-0 items-center justify-between gap-2 rounded-full px-3 py-1.5 text-sm font-medium md:rounded-lg md:py-2 ${
              c.id === channelId ? 'bg-teal-700 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200 md:bg-transparent'
            }`}
          >
            <span># {c.name}</span>
            {(unread[c.id] ?? 0) > 0 && (
              <span className="rounded-full bg-amber-400 px-1.5 text-xs font-bold text-slate-900">{unread[c.id]}</span>
            )}
          </button>
        ))}
        {user?.role === 'admin' && (
          <button
            onClick={() => setCreating((v) => !v)}
            className="flex shrink-0 items-center gap-1 rounded-full border border-dashed border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 md:rounded-lg"
          >
            <Icon name="plus" className="h-4 w-4" /> Salon
          </button>
        )}
      </nav>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        {creating && (
          <form onSubmit={createChannel} className="flex flex-wrap items-end gap-2 border-b border-slate-200 bg-amber-50 px-4 py-3">
            <label className="text-sm font-medium">
              Nom du salon
              <input name="name" className="field mt-1" placeholder="ex. projets" required minLength={2} maxLength={30} />
            </label>
            <label className="min-w-40 flex-1 text-sm font-medium">
              Description (facultatif)
              <input name="description" className="field mt-1" maxLength={200} />
            </label>
            <button className="btn btn-primary">Créer</button>
          </form>
        )}

        {channel && (
          <div className="border-b border-slate-200 bg-white px-4 py-2">
            <h2 className="font-semibold"># {channel.name}</h2>
            {channel.description && <p className="text-xs text-slate-500">{channel.description}</p>}
          </div>
        )}

        <div
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
          className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 py-3"
        >
          {hasMore && (
            <div className="text-center">
              <button className="btn btn-ghost !py-1.5" onClick={() => void loadOlder()}>
                Messages précédents
              </button>
            </div>
          )}
          {loading && messages.length === 0 && <p className="py-8 text-center text-sm text-slate-500">Chargement…</p>}
          {!loading && messages.length === 0 && (
            <p className="py-10 text-center text-sm text-slate-500">Aucun message pour l'instant. Lancez la discussion !</p>
          )}
          {messages.map((m, i) => {
            const prev = messages[i - 1];
            const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
            const mine = m.user.id === user?.id;
            const grouped = !newDay && prev?.user.id === m.user.id && +new Date(m.createdAt) - +new Date(prev.createdAt) < 5 * 60_000;
            return (
              <Fragment key={m.id}>
                {newDay && (
                  <div className="py-2 text-center">
                    <span className="rounded-full bg-slate-200 px-3 py-0.5 text-xs font-medium text-slate-600">{formatDay(m.createdAt)}</span>
                  </div>
                )}
                <div className={`flex items-end gap-2 ${mine ? 'flex-row-reverse' : ''} ${grouped ? '' : 'mt-2'}`}>
                  {!mine && (grouped ? <span className="w-8 shrink-0" /> : <Avatar name={m.user.name} size={32} />)}
                  <div
                    className={`max-w-[82%] rounded-2xl px-3 py-2 text-[15px] leading-snug shadow-sm md:max-w-[70%] ${
                      mine ? 'rounded-br-md bg-teal-700 text-white' : 'rounded-bl-md bg-white text-slate-900'
                    }`}
                  >
                    {!mine && !grouped && <p className="mb-0.5 text-xs font-semibold text-teal-800">{m.user.name}</p>}
                    {m.file && (
                      <button
                        onClick={() => m.file && void downloadFile(m.file.id, m.file.name)}
                        className={`mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm ${
                          mine ? 'bg-teal-800 hover:bg-teal-900' : 'bg-slate-100 hover:bg-slate-200'
                        }`}
                      >
                        <Icon name="download" className="h-4 w-4 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{m.file.name}</span>
                        <span className="shrink-0 text-xs opacity-70">{formatSize(m.file.size)}</span>
                      </button>
                    )}
                    {m.body && <p className="whitespace-pre-wrap break-words">{linkify(m.body)}</p>}
                    <p className={`mt-0.5 text-right text-[11px] ${mine ? 'text-teal-100' : 'text-slate-400'}`}>{formatTime(m.createdAt)}</p>
                  </div>
                </div>
              </Fragment>
            );
          })}
        </div>

        <div className="border-t border-slate-200 bg-white p-2">
          <ErrorNote>{error}</ErrorNote>
          {channel && !canWrite ? (
            <p className="px-2 py-3 text-center text-sm text-slate-500">Seuls les administrateurs peuvent écrire dans ce salon.</p>
          ) : (
            <form onSubmit={send} className="flex items-end gap-2">
              <input ref={fileInput} type="file" className="hidden" onChange={(e) => void attach(e.target.files?.[0])} />
              <button
                type="button"
                className="btn btn-ghost !px-2.5"
                onClick={() => fileInput.current?.click()}
                disabled={sending || !channelId}
                aria-label="Joindre un fichier"
              >
                <Icon name="attach" />
              </button>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKeyDown}
                rows={1}
                maxLength={4000}
                placeholder={channel ? `Écrire dans #${channel.name}` : 'Message'}
                className="field max-h-32 min-h-[44px] flex-1 resize-none"
                disabled={!channelId}
              />
              <button className="btn btn-primary !px-3" disabled={sending || !draft.trim()} aria-label="Envoyer">
                <Icon name="send" />
              </button>
            </form>
          )}
        </div>
      </section>
    </div>
  );
}
