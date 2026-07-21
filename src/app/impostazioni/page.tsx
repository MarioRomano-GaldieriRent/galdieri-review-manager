import { WATCHED_MAILBOX } from "@/server/graph/client";
import { loadSettings } from "@/server/settings";
import {
  addLabelAction,
  deleteLabelAction,
  saveMailboxAction,
  updateLabelAction,
} from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Impostazioni — Galdieri rent" };

export default async function ImpostazioniPage() {
  const settings = await loadSettings();

  return (
    <main>
      <h1>Impostazioni</h1>
      <p className="subtitle">
        Casella monitorata ed etichette per filtrare le email. Le impostazioni sono salvate in{" "}
        <code>data/settings.json</code>.
      </p>

      <section className="card">
        <h2>Casella monitorata</h2>
        <form action={saveMailboxAction} className="filters-row">
          <label className="field grow">
            <span>Indirizzo (vuoto = usa quello del file .env)</span>
            <input
              name="mailbox"
              defaultValue={settings.mailbox}
              placeholder={WATCHED_MAILBOX || "nome.cognome@galdierirent.it"}
            />
          </label>
          <div className="filters-actions">
            <button type="submit" className="btn-primary">
              Salva
            </button>
          </div>
        </form>
        <p className="hint">
          In uso adesso: <strong>{settings.mailbox || WATCHED_MAILBOX || "(nessuna)"}</strong>
        </p>
      </section>

      <section className="card">
        <h2>Etichette ({settings.labels.length})</h2>
        <p className="hint" style={{ marginBottom: 16 }}>
          Un&apos;etichetta raccoglie le email il cui <strong>oggetto contiene</strong> un testo.
          Il filtro sul mittente è facoltativo: lascialo vuoto per prendere tutto il flusso
          (notifica originale, ticket e risposte interne).
        </p>

        {settings.labels.map((l) => (
          <form key={l.id} action={updateLabelAction} className="label-row">
            <input type="hidden" name="id" value={l.id} />
            <div className="form-grid">
              <label className="field">
                <span>Nome etichetta</span>
                <input name="name" defaultValue={l.name} required />
              </label>
              <label className="field">
                <span>Oggetto contiene</span>
                <input name="subjectContains" defaultValue={l.subjectContains} required />
              </label>
              <label className="field">
                <span>Mittente contiene (facoltativo)</span>
                <input
                  name="fromContains"
                  defaultValue={l.fromContains}
                  placeholder="es. zapiermail"
                />
              </label>
            </div>
            <div className="label-actions">
              <button type="submit" className="btn-mini">
                Salva modifiche
              </button>
              <button
                type="submit"
                className="btn-mini btn-danger"
                formAction={deleteLabelAction}
              >
                Elimina
              </button>
            </div>
          </form>
        ))}

        {settings.labels.length === 0 && (
          <p className="hint">Nessuna etichetta. Aggiungine una qui sotto.</p>
        )}
      </section>

      <section className="card">
        <h2>Aggiungi etichetta</h2>
        <form action={addLabelAction}>
          <div className="form-grid">
            <label className="field">
              <span>Nome etichetta</span>
              <input name="name" placeholder="Recensioni di Google" required />
            </label>
            <label className="field">
              <span>Oggetto contiene</span>
              <input name="subjectContains" placeholder="NUOVA RECENSIONE GOOGLE" required />
            </label>
            <label className="field">
              <span>Mittente contiene (facoltativo)</span>
              <input name="fromContains" placeholder="lascia vuoto per tutti" />
            </label>
          </div>
          <button type="submit" className="btn-primary" style={{ marginTop: 12 }}>
            Aggiungi
          </button>
        </form>
      </section>
    </main>
  );
}
