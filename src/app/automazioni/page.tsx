import Link from "next/link";
import { isGraphConfigured } from "@/server/graph/client";
import { isFreshdeskConfigured } from "@/server/integrations/freshdesk";
import { caricaRegole, regolaPer } from "@/server/automation/rules";
import { caricaEsecuzioni, ultimePerRecensione } from "@/server/automation/runs";
import { CATALOGO, type Azione, type Esecuzione, type EsitoNodo, type Regola } from "@/server/automation/types";
import { interpola } from "@/server/automation/connectors";
import { tagSede } from "@/server/automation/sedi";
import { caricaRecensioni, haTesto, testoRecensione, type Recensione } from "@/server/reviews/load";
import { loadSettings } from "@/server/settings";
import {
  cambiaStatoRegolaAction,
  eseguiSuRecensioneAction,
  ripristinaRegoleAction,
  salvaNodoAction,
  svuotaRegistroAction,
} from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Automazioni — Galdieri rent" };

const fmt = new Intl.DateTimeFormat("it-IT", { dateStyle: "short", timeStyle: "short" });

const ICONA: Record<string, string> = {
  freshdesk: "🎫",
  google: "★",
  email: "✉",
  sistema: "⏸",
};

function descriviCondizione(r: Regola): string {
  const stelle = r.condizione.stelle.map((s) => `${s}★`).join(" o ");
  const testo =
    r.condizione.testo === "con"
      ? " con testo"
      : r.condizione.testo === "senza"
        ? " senza testo"
        : "";
  return `${stelle}${testo}`;
}

/** Un nodo del flusso, così com'è configurato nella regola. */
function Nodo({ regola, azione }: { regola: Regola; azione: Azione }) {
  const meta = CATALOGO[azione.tipo];
  return (
    <details className={`nodo nodo-${meta.servizio}`}>
      <summary className="nodo-testa">
        <span className="nodo-icona">{ICONA[meta.servizio]}</span>
        <span className="nodo-titolo">{meta.titolo}</span>
        <span className={`nodo-tipo ${meta.scrittura ? "nodo-scrive" : "nodo-legge"}`}>
          {meta.scrittura ? "scrive" : "legge"}
        </span>
      </summary>
      <div className="nodo-corpo">
        <p className="hint">{meta.descrizione}</p>
        {meta.parametri.length === 0 ? (
          <p className="hint">Nessun parametro da configurare.</p>
        ) : (
          <form action={salvaNodoAction}>
            <input type="hidden" name="regolaId" value={regola.id} />
            <input type="hidden" name="azioneId" value={azione.id} />
            {meta.parametri.map((p) => (
              <label key={p.nome} className="field">
                <span>{p.etichetta}</span>
                {p.multilinea ? (
                  <textarea name={`p_${p.nome}`} rows={3} defaultValue={azione.parametri[p.nome] ?? ""} />
                ) : (
                  <input name={`p_${p.nome}`} defaultValue={azione.parametri[p.nome] ?? ""} />
                )}
                {p.aiuto && <small className="hint">{p.aiuto}</small>}
              </label>
            ))}
            <button type="submit" className="btn-mini">
              Salva nodo
            </button>
          </form>
        )}
      </div>
    </details>
  );
}

/** Esito di un nodo dopo un'esecuzione. */
function NodoEseguito({ n }: { n: EsitoNodo }) {
  const simbolo =
    n.stato === "ok" ? "✓" : n.stato === "simulato" ? "◐" : n.stato === "saltato" ? "–" : "✕";
  return (
    <div className={`run-nodo run-${n.stato} nodo-${n.servizio}`}>
      <div className="run-nodo-testa">
        <span className="run-simbolo">{simbolo}</span>
        <span className="nodo-icona">{ICONA[n.servizio]}</span>
        <span className="nodo-titolo">{n.titolo}</span>
        <span className="run-durata">{n.durataMs} ms</span>
      </div>
      <p className="run-messaggio">{n.messaggio}</p>
      {n.chiamata && (
        <details className="run-chiamata">
          <summary>
            {n.stato === "ok" ? "Chiamata effettuata" : "Chiamata che sarebbe stata fatta"}
          </summary>
          <pre>
            {n.chiamata.metodo} {n.chiamata.url}
            {n.chiamata.corpo ? `\n\n${n.chiamata.corpo}` : ""}
          </pre>
        </details>
      )}
    </div>
  );
}

function Esito({ e }: { e: Esecuzione }) {
  const scritture = e.nodi.filter((n) => n.stato === "ok" && n.chiamata).length;
  return (
    <section className={`card run-card ${e.esito === "errore" ? "run-card-ko" : ""}`}>
      <div className="sec-head">
        <h2>
          {e.regolaNome} — {e.recensione.nome} {e.recensione.stelle ? `${e.recensione.stelle}★` : ""}
        </h2>
        <span className={`conn-badge ${e.modo === "reale" ? "conn-ko" : "conn-ok"}`}>
          {e.modo === "reale" ? "ESECUZIONE REALE" : "simulazione"}
        </span>
      </div>
      <p className="hint">
        {fmt.format(new Date(e.quando))} · sede {e.recensione.sede || "—"} ·{" "}
        {scritture === 0
          ? "nessuna modifica effettuata"
          : `${scritture} modifiche effettuate davvero`}
      </p>
      <div className="run-flow">
        {e.nodi.map((n) => (
          <NodoEseguito key={n.azioneId} n={n} />
        ))}
      </div>
    </section>
  );
}

export default async function AutomazioniPage({
  searchParams,
}: {
  searchParams: Promise<{ run?: string; errore?: string }>;
}) {
  const sp = await searchParams;
  const settings = await loadSettings();
  const label = settings.labels[0] ?? null;
  const simulazione = settings.modo !== "reale";

  const [regole, esecuzioni, graphOk, fdOk] = await Promise.all([
    caricaRegole(),
    caricaEsecuzioni(),
    isGraphConfigured(),
    isFreshdeskConfigured(),
  ]);

  let recensioni: Recensione[] = [];
  let errore: string | null = null;
  if (graphOk && label) {
    try {
      recensioni = (await caricaRecensioni(label)).recensioni;
    } catch (e) {
      errore = e instanceof Error ? e.message : "Errore sconosciuto";
    }
  }

  const ultime = await ultimePerRecensione();
  const runAperta = sp.run ? esecuzioni.find((e) => e.id === sp.run) : undefined;

  return (
    <main>
      <h1>Automazioni</h1>
      <p className="subtitle">
        Le regole che decidono cosa fare a ogni recensione, e la prova di cosa succederebbe.
      </p>

      {/* -------------------------------------------------- modalità operativa */}
      <section className={`card modo-banner ${simulazione ? "modo-sim" : "modo-reale"}`}>
        <div className="sec-head">
          <h2>{simulazione ? "Modalità simulazione" : "Modalità reale"}</h2>
          <Link href="/impostazioni#modo" className="btn-secondary">
            Cambia in Impostazioni
          </Link>
        </div>
        {simulazione ? (
          <p>
            Nessuna scrittura verso l&apos;esterno. I nodi di lettura girano davvero — per questo
            l&apos;esecuzione sa dirti <em>quale</em> ticket avrebbe toccato — ma niente viene
            modificato su Freshdesk, su Google o nella posta.
          </p>
        ) : (
          <p>
            <strong>Le azioni vengono eseguite davvero.</strong> Ticket modificati, email inviate.
            L&apos;esecuzione resta comunque a conferma: parte una recensione alla volta, mai da
            sola.
          </p>
        )}
      </section>

      {sp.errore && (
        <section className="card">
          <p className="form-error">
            {sp.errore === "nessuna-regola"
              ? "Nessuna regola attiva copre questa recensione."
              : "Recensione non trovata: potrebbe essere uscita dalle ultime 50 email."}
          </p>
        </section>
      )}

      {runAperta && <Esito e={runAperta} />}

      {/* ----------------------------------------------------------- le regole */}
      <section className="card">
        <div className="sec-head">
          <h2>Regole ({regole.filter((r) => r.attiva).length} attive su {regole.length})</h2>
          <form action={ripristinaRegoleAction}>
            <button type="submit" className="btn-secondary">
              Ripristina regole iniziali
            </button>
          </form>
        </div>
        <p className="hint">
          Ricalcano quello che oggi viene fatto a mano: valori presi dai ticket reali. Apri un nodo
          per modificarne il contenuto.
        </p>
      </section>

      {regole.map((r) => (
        <section key={r.id} className={`card regola ${r.attiva ? "" : "regola-spenta"}`}>
          <div className="sec-head">
            <h2>
              <span className="regola-cond">{descriviCondizione(r)}</span> {r.nome}
            </h2>
            <form action={cambiaStatoRegolaAction}>
              <input type="hidden" name="id" value={r.id} />
              <button type="submit" className={r.attiva ? "btn-mini" : "btn-mini btn-danger"}>
                {r.attiva ? "Attiva — disattiva" : "Disattivata — attiva"}
              </button>
            </form>
          </div>
          <div className="flow">
            {r.azioni.map((a, i) => (
              <div key={a.id} className="flow-step">
                {i > 0 && <span className="flow-freccia">→</span>}
                <Nodo regola={r} azione={a} />
              </div>
            ))}
          </div>
        </section>
      ))}

      {/* ------------------------------------------------------ le recensioni */}
      <section className="card">
        <h2>Recensioni da lavorare ({recensioni.length})</h2>
        {!graphOk && <p className="form-error">Microsoft Graph non è configurato.</p>}
        {!fdOk && (
          <p className="notice">
            Freshdesk non è configurato: il nodo «Trova il ticket» non troverà nulla.
          </p>
        )}
        {errore && <p className="form-error">Errore nella lettura: {errore}</p>}
        <p className="hint">
          Ogni riga mostra quale regola scatterebbe. Premi <strong>Esegui</strong> per far girare il
          flusso su quella singola recensione.
        </p>
      </section>

      <div className="review-grid">
        {recensioni.map((r) => {
          const conTesto = haTesto(r);
          const regola = regolaPer(regole, r.stelle, conTesto);
          const ultima = ultime.get(r.chiave);
          const anteprima = regola?.azioni.find((a) => a.tipo === "google.rispondi");

          return (
            <article key={r.chiave} className="review-card">
              <header className="review-head">
                <div className="review-head-main">
                  <span className="review-name">{r.nome}</span>
                  {r.sede && (
                    <span className="review-place">
                      {r.sede}
                      {tagSede(r.sede) && <span className="muted"> · {tagSede(r.sede)}</span>}
                    </span>
                  )}
                  <span className="review-date">{fmt.format(new Date(r.ricevutaIl))}</span>
                </div>
                <span className={`stars-badge stars-${r.stelle ?? 0}`}>
                  {"★".repeat(r.stelle ?? 0)}
                  <span className="stars-empty">{"★".repeat(5 - (r.stelle ?? 0))}</span>
                </span>
              </header>

              <p className={`review-comment ${conTesto ? "" : "muted"}`}>
                {conTesto ? testoRecensione(r) : "— nessun commento, solo punteggio —"}
              </p>

              <div className="review-flags">
                {regola ? (
                  <span className="flag flag-green">regola: {regola.nome}</span>
                ) : (
                  <span className="flag flag-amber">nessuna regola</span>
                )}
                {ultima && (
                  <span className={`flag ${ultima.esito === "errore" ? "flag-red" : "flag-gray"}`}>
                    già eseguita {fmt.format(new Date(ultima.quando))}
                  </span>
                )}
              </div>

              {anteprima && (
                <details className="review-original">
                  <summary>Risposta che verrebbe pubblicata su Google</summary>
                  <p>{interpola(anteprima.parametri.testo ?? "", r)}</p>
                </details>
              )}

              <footer className="review-foot">
                <form action={eseguiSuRecensioneAction}>
                  <input type="hidden" name="chiave" value={r.chiave} />
                  <input type="hidden" name="label" value={label?.id ?? ""} />
                  <button
                    type="submit"
                    className={simulazione ? "btn-primary" : "btn-primary btn-danger"}
                    disabled={!regola}
                  >
                    {simulazione ? "Esegui simulazione" : "Esegui davvero"}
                  </button>
                </form>
                {ultima && (
                  <Link className="btn-mini" href={`/automazioni?run=${ultima.id}`}>
                    Ultimo esito →
                  </Link>
                )}
                <Link className="btn-mini" href={`/email?id=${encodeURIComponent(r.messaggioId)}`}>
                  Email →
                </Link>
              </footer>
            </article>
          );
        })}
      </div>

      {/* -------------------------------------------------------- il registro */}
      <section className="card">
        <div className="sec-head">
          <h2>Registro esecuzioni ({esecuzioni.length})</h2>
          {esecuzioni.length > 0 && (
            <form action={svuotaRegistroAction}>
              <button type="submit" className="btn-secondary">
                Svuota
              </button>
            </form>
          )}
        </div>
        {esecuzioni.length === 0 ? (
          <p className="hint">Nessuna esecuzione ancora.</p>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Quando</th>
                  <th>Recensione</th>
                  <th>Regola</th>
                  <th>Modo</th>
                  <th>Esito</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {esecuzioni.slice(0, 30).map((e) => (
                  <tr key={e.id}>
                    <td className="nowrap">{fmt.format(new Date(e.quando))}</td>
                    <td>
                      {e.recensione.nome}{" "}
                      <span className="muted">
                        {e.recensione.stelle}★ {e.recensione.sede}
                      </span>
                    </td>
                    <td>{e.regolaNome}</td>
                    <td className="nowrap">{e.modo}</td>
                    <td>
                      <span
                        className={`status-badge ${e.esito === "errore" ? "st-new" : "st-published"}`}
                      >
                        {e.esito === "errore" ? "errore" : "completata"}
                      </span>
                    </td>
                    <td>
                      <Link className="btn-mini" href={`/automazioni?run=${e.id}`}>
                        Dettaglio
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
