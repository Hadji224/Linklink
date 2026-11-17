import { useState, type FormEvent } from 'react';
import { ErrorNote, Field, Modal } from '../ui';

export interface FormField {
  name: string;
  label: string;
  type?: 'text' | 'textarea' | 'number' | 'date' | 'password' | 'select';
  options?: { value: string; label: string }[];
  required?: boolean;
  hint?: string;
  value?: string;
  min?: number;
  maxLength?: number;
}

/** Petite boîte de dialogue de saisie (motifs, montants, dates…) : validation côté serveur, erreurs affichées dans la boîte. */
export function FormModal({
  title, intro, fields, submitLabel = 'Valider', danger = false, onClose, onSubmit,
}: {
  title: string;
  intro?: string;
  fields: FormField[];
  submitLabel?: string;
  danger?: boolean;
  onClose: () => void;
  onSubmit: (values: Record<string, string>) => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.name, f.value ?? ''])));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onSubmit(values);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action impossible.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {intro && <p className="text-sm text-slate">{intro}</p>}
        {fields.map((f) => (
          <Field key={f.name} label={f.label} hint={f.hint}>
            {f.type === 'textarea' ? (
              <textarea className="field" rows={3} required={f.required} maxLength={f.maxLength ?? 500} value={values[f.name]} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} />
            ) : f.type === 'select' ? (
              <select className="field" required={f.required} value={values[f.name]} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}>
                <option value="">Choisir…</option>
                {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ) : (
              <input className="field" type={f.type ?? 'text'} min={f.min} step={f.type === 'number' ? 'any' : undefined} required={f.required} maxLength={f.maxLength} autoComplete={f.type === 'password' ? 'current-password' : 'off'} value={values[f.name]} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} />
            )}
          </Field>
        ))}
        <ErrorNote>{error}</ErrorNote>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Annuler</button>
          <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} disabled={busy}>{busy ? 'Envoi…' : submitLabel}</button>
        </div>
      </form>
    </Modal>
  );
}
