import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { api, downloadFile, fetchBlobUrl } from '../api';
import { useAuth } from '../auth';
import { useApp } from '../data';
import { formatShortDate, formatSize } from '../format';
import { useRealtime, useRealtimeEvents } from '../realtime';
import { LEVEL_HELP, LEVEL_LABEL, type DocFile, type Folder, type Level } from '../types';
import { Empty, ErrorNote, Field, FileIcon, Icon, LevelChip, Modal, PageHeader, Spinner, useConfirm, useToast } from '../ui';

const LEVELS: Level[] = ['public', 'internal', 'confidential', 'strict'];

function LevelSelect({ value, onChange }: { value: Level; onChange: (l: Level) => void }) {
  return (
    <Field label="Niveau de confidentialité" hint={LEVEL_HELP[value]}>
      <select className="field" value={value} onChange={(e) => onChange(e.target.value as Level)}>
        {LEVELS.map((l) => <option key={l} value={l}>{LEVEL_LABEL[l]}</option>)}
      </select>
    </Field>
  );
}

function UploadModal({ folderId, folderName, onClose, onDone }: { folderId: string; folderName: string; onClose: () => void; onDone: () => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [level, setLevel] = useState<Level>('internal');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);

  async function send() {
    setBusy(true);
    setError('');
    let sent = 0;
    for (const f of files) {
      try {
        const form = new FormData();
        form.append('file', f);
        form.append('folderId', folderId);
        form.append('level', level);
        await api('/files', { method: 'POST', form });
        sent += 1;
      } catch (e) {
        setError(`${f.name} : ${e instanceof Error ? e.message : 'envoi impossible.'}`);
        break;
      }
    }
    setBusy(false);
    if (sent) {
      toast.success(sent > 1 ? `${sent} fichiers déposés` : 'Fichier déposé');
      onDone();
    }
    if (sent === files.length) onClose();
    else setFiles(files.slice(sent));
  }

  return (
    <Modal title={`Déposer dans « ${folderName} »`} onClose={onClose}>
      <div className="space-y-3">
        <input ref={input} type="file" multiple className="hidden" aria-label="Choisir des fichiers" onChange={(e) => setFiles([...files, ...Array.from(e.target.files ?? [])])} />
        <button className="btn btn-ghost w-full" onClick={() => input.current?.click()}><Icon name="upload" className="h-4 w-4" /> Choisir des fichiers</button>
        <p className="text-xs text-slate">PDF, Word, Excel, PowerPoint, images, ZIP, vidéos légères… 25 Mo maximum par fichier.</p>
        {files.length > 0 && (
          <ul className="space-y-1">
            {files.map((f, i) => (
              <li key={i} className="flex items-center justify-between rounded-lg bg-mist px-3 py-1.5 text-sm">
                <span className="min-w-0 truncate">{f.name} <span className="text-slate">({formatSize(f.size)})</span></span>
                <button onClick={() => setFiles(files.filter((_, j) => j !== i))} aria-label={`Retirer ${f.name}`} className="text-slate hover:text-red-700"><Icon name="x" className="h-4 w-4" /></button>
              </li>
            ))}
          </ul>
        )}
        <LevelSelect value={level} onChange={setLevel} />
        <ErrorNote>{error}</ErrorNote>
        <div className="flex justify-end gap-2">
          <button className="btn btn-ghost" onClick={onClose}>Annuler</button>
          <button className="btn btn-primary" disabled={!files.length || busy} onClick={() => void send()}>{busy ? 'Envoi…' : `Déposer ${files.length || ''}`.trim()}</button>
        </div>
      </div>
    </Modal>
  );
}

function PreviewModal({ file, onClose }: { file: DocFile; onClose: () => void }) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let revoked = '';
    fetchBlobUrl(`/files/${file.id}/preview`).then((u) => { revoked = u; setUrl(u); }).catch((e) => setError(e instanceof Error ? e.message : 'Aperçu impossible.'));
    return () => { if (revoked) URL.revokeObjectURL(revoked); };
  }, [file.id]);
  return (
    <Modal title={file.name} onClose={onClose} wide>
      <ErrorNote>{error}</ErrorNote>
      {!url && !error && <Spinner />}
      {url && <img src={url} alt={file.name} className="mx-auto max-h-[70dvh] rounded-xl" />}
      <div className="mt-3 text-right"><button className="btn btn-primary btn-sm" onClick={() => void downloadFile(file.id, file.name)}>Télécharger</button></div>
    </Modal>
  );
}

function LevelModal({ file, onClose, onDone }: { file: DocFile; onClose: () => void; onDone: () => void }) {
  const [level, setLevel] = useState<Level>(file.level);
  const [error, setError] = useState('');
  const toast = useToast();
  return (
    <Modal title="Confidentialité du fichier" onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm font-semibold">{file.name}</p>
        <LevelSelect value={level} onChange={setLevel} />
        <ErrorNote>{error}</ErrorNote>
        <div className="flex justify-end gap-2">
          <button className="btn btn-ghost" onClick={onClose}>Annuler</button>
          <button className="btn btn-primary" onClick={async () => {
            try { await api(`/files/${file.id}`, { method: 'PATCH', body: { level } }); toast.success('Niveau modifié'); onDone(); onClose(); }
            catch (e) { setError(e instanceof Error ? e.message : 'Modification impossible.'); }
          }}>Enregistrer</button>
        </div>
      </div>
    </Modal>
  );
}

export function FileBrowser({ rootFolderId, readOnly = false }: { rootFolderId?: string; readOnly?: boolean }) {
  const { user } = useAuth();
  const { members } = useApp();
  const { epoch } = useRealtime();
  const toast = useToast();
  const confirm = useConfirm();
  const [folders, setFolders] = useState<Folder[]>([]);
  const [files, setFiles] = useState<DocFile[] | null>(null);
  const [current, setCurrent] = useState<string | null>(rootFolderId ?? null);
  const [q, setQ] = useState('');
  const [author, setAuthor] = useState('');
  const [level, setLevel] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState('');
  const [upload, setUpload] = useState(false);
  const [preview, setPreview] = useState<DocFile | null>(null);
  const [levelFor, setLevelFor] = useState<DocFile | null>(null);
  const [dragging, setDragging] = useState(false);
  const [newFolder, setNewFolder] = useState(false);
  const [folderName, setFolderName] = useState('');

  const searching = !!(q.trim() || author || level || from || to);
  const byId = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);
  const pathOf = useCallback((id: string | null) => {
    const out: Folder[] = [];
    let cur = id ? byId.get(id) : undefined;
    for (let i = 0; cur && i < 30; i++) {
      out.unshift(cur);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return out;
  }, [byId]);
  const inScope = useCallback((folderId: string) => !rootFolderId || pathOf(folderId).some((f) => f.id === rootFolderId), [rootFolderId, pathOf]);

  const loadFolders = useCallback(async () => {
    try { setFolders((await api<{ folders: Folder[] }>('/folders')).folders); } catch (e) { setError(e instanceof Error ? e.message : 'Chargement impossible.'); }
  }, []);

  const loadFiles = useCallback(async () => {
    const p = new URLSearchParams();
    if (searching) {
      if (q.trim()) p.set('q', q.trim());
      if (author) p.set('author', author);
      if (level) p.set('level', level);
      if (from) p.set('from', from);
      if (to) p.set('to', to);
    } else if (current) p.set('folderId', current);
    else if (!rootFolderId) { setFiles([]); return; }
    try {
      const r = await api<{ files: DocFile[] }>(`/files?${p}`);
      setFiles(r.files);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Chargement impossible.');
    }
  }, [searching, q, author, level, from, to, current, rootFolderId]);

  useEffect(() => { void loadFolders(); }, [loadFolders, epoch]);
  useEffect(() => { const t = setTimeout(() => void loadFiles(), searching ? 250 : 0); return () => clearTimeout(t); }, [loadFiles, epoch, searching]);
  useRealtimeEvents((e) => { if (e.type === 'file') { void loadFolders(); void loadFiles(); } });

  const crumbs = pathOf(current);
  const here = current ? byId.get(current) : undefined;
  const roots = folders.filter((f) => !f.parentId && (!f.projectId || f.system === 'project')).filter((f) => !rootFolderId);
  const subfolders = rootFolderId || current ? folders.filter((f) => f.parentId === (current ?? rootFolderId)) : roots;
  const shownFiles = (files ?? []).filter((f) => inScope(f.folderId));

  const canUploadHere = !readOnly && !!current && here?.system !== 'messages';
  const canMkdir = !readOnly && here?.system !== 'messages' && (!!current || user?.role !== 'guest');
  const canDelete = (f: DocFile) => user?.role === 'admin' || (user?.role === 'member' && f.uploadedBy.id === user.id);
  const canEdit = (f: DocFile) => !readOnly && (user?.role === 'admin' || f.uploadedBy.id === user?.id);

  async function createFolder() {
    try {
      await api('/folders', { method: 'POST', body: { name: folderName, parentId: current } });
      setNewFolder(false);
      setFolderName('');
      toast.success('Dossier créé');
      void loadFolders();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Création impossible.');
    }
  }

  async function removeFile(f: DocFile) {
    if (!(await confirm({ title: `Supprimer « ${f.name} » ?`, message: 'Cette action est définitive.', confirmLabel: 'Supprimer', danger: true }))) return;
    try { await api(`/files/${f.id}`, { method: 'DELETE' }); toast.success('Fichier supprimé'); void loadFiles(); void loadFolders(); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Suppression impossible.'); }
  }

  async function removeFolder(f: Folder) {
    if (!(await confirm({ title: `Supprimer le dossier « ${f.name} » ?`, message: 'Ses sous-dossiers et fichiers seront supprimés.', confirmLabel: 'Supprimer', danger: true }))) return;
    try { await api(`/folders/${f.id}`, { method: 'DELETE' }); toast.success('Dossier supprimé'); void loadFolders(); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Suppression impossible.'); }
  }

  // Glisser-déposer (F-FILE-01).
  async function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (!canUploadHere || !current) return;
    const dropped = Array.from(e.dataTransfer.files);
    let n = 0;
    for (const file of dropped) {
      try {
        const form = new FormData();
        form.append('file', file);
        form.append('folderId', current);
        form.append('level', 'internal');
        await api('/files', { method: 'POST', form });
        n += 1;
      } catch (err) {
        toast.error(`${file.name} : ${err instanceof Error ? err.message : 'envoi impossible.'}`);
      }
    }
    if (n) { toast.success(n > 1 ? `${n} fichiers déposés` : 'Fichier déposé'); void loadFiles(); void loadFolders(); }
  }

  const root = rootFolderId ? byId.get(rootFolderId) : undefined;

  return (
    <div
      className={`relative flex min-h-0 flex-1 flex-col ${dragging ? 'ring-2 ring-electric ring-inset' : ''}`}
      onDragOver={(e) => { if (canUploadHere) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={(e) => void onDrop(e)}
    >
      <div className="space-y-2 border-b border-line bg-white p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-44 flex-1">
            <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate" />
            <input className="field !pl-9" placeholder="Rechercher un fichier" aria-label="Rechercher un fichier" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {canMkdir && <button className="btn btn-ghost" onClick={() => setNewFolder(true)}><Icon name="plus" className="h-4 w-4" /> Dossier</button>}
          {canUploadHere && <button className="btn btn-primary" onClick={() => setUpload(true)}><Icon name="upload" className="h-4 w-4" /> Déposer</button>}
        </div>
        <details>
          <summary className="cursor-pointer text-sm font-semibold text-electric">Filtres{searching && ' (actifs)'}</summary>
          <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-4">
            <select className="field" aria-label="Auteur" value={author} onChange={(e) => setAuthor(e.target.value)}><option value="">Tous les auteurs</option>{members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
            <select className="field" aria-label="Confidentialité" value={level} onChange={(e) => setLevel(e.target.value)}><option value="">Tous niveaux</option>{LEVELS.map((l) => <option key={l} value={l}>{LEVEL_LABEL[l]}</option>)}</select>
            <input className="field" type="date" aria-label="Déposé après le" value={from} onChange={(e) => setFrom(e.target.value)} />
            <input className="field" type="date" aria-label="Déposé avant le" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          {searching && <button className="mt-2 text-sm font-semibold text-electric underline" onClick={() => { setQ(''); setAuthor(''); setLevel(''); setFrom(''); setTo(''); }}>Effacer les filtres</button>}
        </details>
        {!searching && (
          <nav aria-label="Chemin du dossier" className="flex flex-wrap items-center gap-1 text-sm">
            {!rootFolderId && <button className={`font-semibold ${current ? 'text-electric hover:underline' : ''}`} onClick={() => setCurrent(null)}>Documents</button>}
            {crumbs.filter((c) => !rootFolderId || pathOf(c.id).some((p) => p.id === rootFolderId)).map((c, i, arr) => (
              <span key={c.id} className="flex items-center gap-1">
                {(i > 0 || !rootFolderId) && <span className="text-slate">/</span>}
                <button className={`font-semibold ${i === arr.length - 1 ? '' : 'text-electric hover:underline'}`} onClick={() => setCurrent(c.id)}>{rootFolderId && c.id === rootFolderId ? 'Racine du projet' : c.name}</button>
              </span>
            ))}
            {rootFolderId && !current && root && <button className="font-semibold" onClick={() => setCurrent(root.id)}>Racine du projet</button>}
          </nav>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <ErrorNote>{error}</ErrorNote>
        {!searching && (
          <ul className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3" aria-label="Dossiers">
            {subfolders.map((f) => (
              <li key={f.id} className="card flex items-center gap-2 p-2 hover:border-electric">
                <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => setCurrent(f.id)}>
                  <Icon name={f.system === 'messages' ? 'chat' : 'folder'} className="h-6 w-6 shrink-0 text-electric" />
                  <span className="min-w-0"><span className="block truncate font-semibold">{f.system === 'project' ? `Projet · ${f.name}` : f.name}</span><span className="text-xs text-slate">{f.fileCount} fichier{f.fileCount > 1 ? 's' : ''}</span></span>
                </button>
                {!f.system && user?.role !== 'guest' && !readOnly && <button className="p-1 text-slate hover:text-red-700" aria-label={`Supprimer le dossier ${f.name}`} onClick={() => void removeFolder(f)}><Icon name="trash" className="h-4 w-4" /></button>}
              </li>
            ))}
          </ul>
        )}

        {files === null && !error && <Spinner />}
        {files && shownFiles.length === 0 && (
          <Empty>{searching ? 'Aucun fichier ne correspond.' : !current && !rootFolderId ? 'Ouvrez un dossier pour voir ses fichiers.' : `Dossier vide.${canUploadHere ? ' Glissez des fichiers ici ou utilisez « Déposer ».' : ''}`}</Empty>
        )}
        <ul className="space-y-2" aria-label="Fichiers">
          {shownFiles.map((f) => (
            <li key={f.id} className="card flex flex-wrap items-center gap-3 p-3">
              <FileIcon name={f.name} mime={f.mime} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{f.name}</p>
                <p className="text-xs text-slate">
                  {formatSize(f.size)} · {f.uploadedBy.name} · {formatShortDate(f.createdAt)}
                  {searching && byId.get(f.folderId) && <> · <button className="font-semibold text-electric hover:underline" onClick={() => { setQ(''); setAuthor(''); setLevel(''); setFrom(''); setTo(''); setCurrent(f.folderId); }}>{byId.get(f.folderId)?.name}</button></>}
                </p>
              </div>
              <LevelChip level={f.level} />
              <div className="flex items-center">
                {f.previewable && <button className="rounded-lg p-2 text-slate hover:bg-mist hover:text-navy" aria-label={`Aperçu de ${f.name}`} onClick={() => setPreview(f)}><Icon name="eye" /></button>}
                <button className="rounded-lg p-2 text-slate hover:bg-mist hover:text-navy" aria-label={`Télécharger ${f.name}`} onClick={() => void downloadFile(f.id, f.name)}><Icon name="download" /></button>
                {canEdit(f) && <button className="rounded-lg p-2 text-slate hover:bg-mist hover:text-navy" aria-label={`Changer la confidentialité de ${f.name}`} onClick={() => setLevelFor(f)}><Icon name="lock" /></button>}
                {!readOnly && canDelete(f) && <button className="rounded-lg p-2 text-slate hover:bg-red-50 hover:text-red-700" aria-label={`Supprimer ${f.name}`} onClick={() => void removeFile(f)}><Icon name="trash" /></button>}
              </div>
            </li>
          ))}
        </ul>
      </div>

      {upload && current && here && <UploadModal folderId={current} folderName={here.name} onClose={() => setUpload(false)} onDone={() => { void loadFiles(); void loadFolders(); }} />}
      {preview && <PreviewModal file={preview} onClose={() => setPreview(null)} />}
      {levelFor && <LevelModal file={levelFor} onClose={() => setLevelFor(null)} onDone={() => void loadFiles()} />}
      {newFolder && (
        <Modal title="Nouveau dossier" onClose={() => setNewFolder(false)}>
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void createFolder(); }}>
            <Field label="Nom du dossier"><input className="field" value={folderName} onChange={(e) => setFolderName(e.target.value)} maxLength={60} required /></Field>
            <div className="flex justify-end gap-2"><button type="button" className="btn btn-ghost" onClick={() => setNewFolder(false)}>Annuler</button><button className="btn btn-primary">Créer</button></div>
          </form>
        </Modal>
      )}
    </div>
  );
}

export function Documents() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Documents" />
      <FileBrowser />
    </div>
  );
}
