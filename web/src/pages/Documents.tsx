import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { api, downloadFile } from '../api';
import { useAuth } from '../auth';
import { formatShortDate, formatSize } from '../format';
import { useRealtime, useRealtimeEvents } from '../realtime';
import type { DocFile } from '../types';
import { Avatar, ErrorNote, Icon, PageHeader, Spinner } from '../ui';

export function Documents() {
  const { user } = useAuth();
  const { epoch } = useRealtime();
  const [files, setFiles] = useState<DocFile[] | null>(null);
  const [folder, setFolder] = useState<string>('Tous');
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [query, setQuery] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ files: DocFile[] }>('/files');
      setFiles(r.files);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Chargement impossible.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, epoch]);

  useRealtimeEvents((e) => {
    if (e.type === 'file') void load();
  });

  const folders = useMemo(() => [...new Set((files ?? []).map((f) => f.folder))].sort((a, b) => a.localeCompare(b, 'fr')), [files]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (files ?? []).filter(
      (f) => (folder === 'Tous' || f.folder === folder) && (!q || f.name.toLowerCase().includes(q)),
    );
  }, [files, folder, query]);

  async function upload(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const picked = fileInput.current?.files;
    if (!picked || picked.length === 0) {
      setError('Choisissez au moins un fichier.');
      return;
    }
    const folderName = String(new FormData(e.currentTarget).get('folder') ?? '').trim() || 'Général';
    setUploading(true);
    setError('');
    const failures: string[] = [];
    for (const file of Array.from(picked)) {
      try {
        const form = new FormData();
        form.append('file', file);
        form.append('folder', folderName);
        await api('/files', { method: 'POST', form });
      } catch (err) {
        failures.push(`${file.name} : ${err instanceof Error ? err.message : 'échec'}`);
      }
    }
    setUploading(false);
    await load();
    if (failures.length) setError(failures.join(' • '));
    else {
      setShowForm(false);
      setFolder(folderName);
    }
  }

  async function remove(f: DocFile) {
    if (!window.confirm(`Supprimer « ${f.name} » ?`)) return;
    try {
      await api(`/files/${f.id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Suppression impossible.');
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Documents">
        <button className="btn btn-primary" onClick={() => setShowForm((v) => !v)}>
          <Icon name="plus" className="h-4 w-4" /> Déposer
        </button>
      </PageHeader>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 md:mx-auto md:w-full md:max-w-3xl">
        {showForm && (
          <form onSubmit={upload} className="card space-y-3 border-teal-200 bg-teal-50/40 p-4">
            <label className="block text-sm font-medium">
              Dossier
              <input name="folder" list="folders" className="field mt-1" placeholder="ex. Dossiers Campus France" defaultValue={folder === 'Tous' ? '' : folder} maxLength={60} />
              <datalist id="folders">
                {folders.map((f) => (
                  <option key={f} value={f} />
                ))}
              </datalist>
              <span className="mt-1 block text-xs font-normal text-slate-500">Choisissez un dossier existant ou tapez un nouveau nom.</span>
            </label>
            <label className="block text-sm font-medium">
              Fichiers (25 Mo maximum chacun)
              <input ref={fileInput} type="file" multiple className="field mt-1 !p-2" required />
            </label>
            <div className="flex gap-2">
              <button className="btn btn-primary" disabled={uploading}>
                {uploading ? 'Envoi en cours…' : 'Envoyer'}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setShowForm(false)} disabled={uploading}>
                Annuler
              </button>
            </div>
          </form>
        )}

        <ErrorNote>{error}</ErrorNote>

        {files && files.length > 0 && (
          <>
            <input
              type="search"
              className="field"
              placeholder="Rechercher un fichier…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Rechercher un fichier"
            />
            <div className="flex gap-2 overflow-x-auto pb-1">
              {['Tous', ...folders].map((f) => (
                <button
                  key={f}
                  onClick={() => setFolder(f)}
                  aria-pressed={folder === f}
                  className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium ${
                    folder === f ? 'bg-teal-700 text-white' : 'bg-white text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50'
                  }`}
                >
                  {f !== 'Tous' && <Icon name="folder" className="h-4 w-4" />}
                  {f}
                </button>
              ))}
            </div>
          </>
        )}

        {files === null && !error && <Spinner />}
        {files && files.length === 0 && (
          <p className="py-10 text-center text-sm text-slate-500">
            Aucun document pour l'instant. Utilisez « Déposer » pour partager un dossier avec l'équipe.
          </p>
        )}
        {files && files.length > 0 && visible.length === 0 && (
          <p className="py-8 text-center text-sm text-slate-500">Aucun fichier ne correspond.</p>
        )}

        <ul className="space-y-2">
          {visible.map((f) => (
            <li key={f.id} className="card flex items-center gap-3 p-3">
              <Avatar name={f.uploadedBy.name} size={36} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{f.name}</p>
                <p className="truncate text-xs text-slate-500">
                  {f.folder} · {formatSize(f.size)} · {f.uploadedBy.name} · {formatShortDate(f.createdAt)}
                </p>
              </div>
              <button className="btn btn-ghost !px-2.5" onClick={() => void downloadFile(f.id, f.name).catch((e) => setError(e instanceof Error ? e.message : 'Téléchargement impossible.'))} aria-label={`Télécharger ${f.name}`}>
                <Icon name="download" />
              </button>
              {(user?.role === 'admin' || user?.id === f.uploadedBy.id) && (
                <button className="btn btn-danger !px-2.5" onClick={() => void remove(f)} aria-label={`Supprimer ${f.name}`}>
                  <Icon name="trash" />
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
