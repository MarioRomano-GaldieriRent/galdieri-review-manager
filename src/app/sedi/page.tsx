import Link from "next/link";
import { leggiSedi, type Sede } from "@/server/db/sedi";
import { importaCsvAction, salvaLinkSedeAction } from "./actions";

// Pagina admin delle sedi: per ognuna il link di gestione recensioni su Google.
// È il metodo primario della cascata §4 (URL della sede). Import/export CSV per
// compilarle tutte in una volta.

export const dynamic = "force-dynamic";
export const metadata = { title: "Sedi — Galdieri rent" };

function livelloLink(s: Sede): { testo: string; classe: string } {
  if (s.googleReviewsUrl) return { testo: "link diretto", classe: "conn-ok" };
  if (s.placeId) return { testo: "da place_id", classe: "conn-ok" };
  return { testo: "solo generico", classe: "conn-ko" };
}

export default async function SediPage({
  searchParams,
}: {
  searchParams: Promise<{
    salvata?: string;
    imp?: string;
    agg?: string;
    ign?: string;
    err?: string;
  }>;
}) {
  const sp = await searchParams;
  const sedi = await leggiSedi();
  const conLink = sedi.filter((s) => s.googleReviewsUrl || s.placeId).length;

  return (
    <main>
      <h1>Sedi</h1>
      <p className="subtitle">
        Il link di gestione recensioni di ogni sede su Google. Con il link diretto, «Apri su Google»
        nella coda porta esattamente alla pagina giusta — {conLink} sedi su {sedi.length} già
        compilate.
      </p>

      <section className="card">
        <h2>Come si trova il link</h2>
        <p className="hint">
          Apri la gestione recensioni della sede su Google (business.google.com, oppure dalla
          ricerca Google da un account gestore), copia l&apos;URL della pagina e incollalo nella
          riga della sede. In alternativa metti il <code>place_id</code> del posto: il link si
          costruisce da sé. Senza né l&apos;uno né l&apos;altro si apre la gestione generica e la
          sede va cercata a mano.
        </p>
      </section>

      {/* --------------------------------------------------- import/export */}
      <section className="card">
        <div className="sec-head">
          <h2>Import / export CSV</h2>
          <a className="btn-secondary" href="/sedi/export">
            Esporta CSV ↓
          </a>
        </div>
        <p className="hint">
          Esporta, compila le colonne <code>googleReviewsUrl</code> e <code>placeId</code>, poi
          reincolla qui sotto. Si aggiornano solo le sedi già presenti, riconosciute dalla chiave o
          dal nome.
        </p>
        {sp.imp && (
          <p className={Number(sp.ign) > 0 ? "notice" : "test-ok"}>
            Importate: {sp.agg} aggiornate, {sp.ign} ignorate.
            {sp.err ? ` (${sp.err})` : ""}
          </p>
        )}
        <form action={importaCsvAction}>
          <label className="field">
            <span>Contenuto del CSV</span>
            <textarea
              name="csv"
              rows={5}
              placeholder="chiave,nome,tagFreshdesk,googleReviewsUrl,placeId&#10;..."
              style={{
                width: "100%",
                fontFamily: "var(--font-mono, monospace)",
                padding: "10px 12px",
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--border)",
                background: "var(--surface)",
                color: "var(--text)",
              }}
            />
          </label>
          <button type="submit" className="btn-primary" style={{ marginTop: 12 }}>
            Importa
          </button>
        </form>
      </section>

      {/* ------------------------------------------------------- le sedi */}
      <section className="card">
        <h2>Tutte le sedi ({sedi.length})</h2>
        {sedi.length === 0 ? (
          <p className="hint">Nessuna sede: compaiono man mano che arrivano le recensioni.</p>
        ) : (
          <div className="sedi-lista">
            {sedi.map((s) => {
              const liv = livelloLink(s);
              const salvata = sp.salvata === s.chiave;
              return (
                <form key={s.chiave} action={salvaLinkSedeAction} className="sede-riga">
                  <input type="hidden" name="chiave" value={s.chiave} />
                  <div className="sede-testa">
                    <span className="sede-nome">{s.nome}</span>
                    {s.tagFreshdesk && <span className="flag flag-gray">{s.tagFreshdesk}</span>}
                    <span className={`conn-badge ${liv.classe}`}>{liv.testo}</span>
                    {salvata && <span className="test-ok sede-salvata">✓ salvata</span>}
                  </div>
                  <div className="form-grid">
                    <label className="field">
                      <span>URL gestione recensioni (Google)</span>
                      <input
                        name="googleReviewsUrl"
                        defaultValue={s.googleReviewsUrl}
                        placeholder="https://business.google.com/reviews/…"
                      />
                    </label>
                    <label className="field">
                      <span>place_id (facoltativo)</span>
                      <input name="placeId" defaultValue={s.placeId} placeholder="ChIJ…" />
                    </label>
                  </div>
                  <div className="label-actions">
                    <button type="submit" className="btn-mini">
                      Salva
                    </button>
                    {s.googleReviewsUrl && (
                      <a
                        className="btn-mini"
                        href={s.googleReviewsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Prova il link ↗
                      </a>
                    )}
                  </div>
                </form>
              );
            })}
          </div>
        )}
      </section>

      <p className="hint">
        <Link href="/da-pubblicare">← Torna alla coda</Link>
      </p>
    </main>
  );
}
