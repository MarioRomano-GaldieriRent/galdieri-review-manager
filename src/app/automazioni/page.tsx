import Link from "next/link";
import { isGraphConfigured } from "@/server/graph/client";
import { isFreshdeskConfigured } from "@/server/integrations/freshdesk";
import { caricaRegole, regolaPer } from "@/server/automation/rules";
import { caricaEsecuzioni, ultimePerRecensione } from "@/server/automation/runs";
import type { Esecuzione } from "@/server/automation/types";
import { interpola } from "@/server/automation/connectors";
import { tagSede } from "@/server/automation/sedi";
import { caricaRecensioni, haTesto, testoRecensione, type Recensione } from "@/server/reviews/load";
import { loadSettings } from "@/server/settings";
import { NodoEseguito } from "../_ui/automazioni";
import {
  eliminaEsecuzioneAction,
  eseguiSuRecensioneAction,
  svuotaRegistroAction,
} from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Automazioni — Galdieri rent" };

const fmt = new Intl.DateTimeFormat("it-IT", { dateStyle: "short", timeStyle: "short" });

function Esito({ e }: { e: Esecuzione }) {
  const scritture = e.nodi.filter((n) => n.stato === "ok" && n.chiamata).length;
  return (
    <section className={`card run-card ${e.esito === "errore" ? "run-card-ko" : ""}`}>
      <div className="sec-head">
        <h2>
          {e.recensione.nome} {e.recensione.stelle ? `${e.recensione.stelle}★` : ""} —{" "}
          {e.regolaNome}
        </h2>
        <span className="thread-actions">
          <span className={`conn-badge ${e.modo === "reale" ? "conn-ko" : "conn-ok"}`}>
            {e.modo === "reale" ? "ESECUZIONE REALE" : "simulazione"}
          </span>
          <form action={eliminaEsecuzioneAction}>
            <input type="hidden" name="id" value={e.id} />
            <button type="submit" className="btn-mini btn-danger">
              Cancella la prova
            </button>
          </form>
        </span>
      </div>
      <p className="hint">
        {fmt.format(new Date(e.quando))} · sede {e.recensione.sede || "—"} ·{" "}
        {scritture === 0
          ? "nessuna modifica effettuata"
          : `${scritture} modifiche effettuate davvero`}
        {" · "}cancellandola la recensione torna «mai eseguita» e la puoi rifare.
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

  // Solo le recensioni per cui una regola scatterebbe davvero: è questa la coda
  // di lavoro. Le altre restano visibili nel pannello Recensioni.
  const inCoda = recensioni
    .map((r) => ({ r, regola: regolaPer(regole, r.stelle, haTesto(r)) }))
    .filter((x) => x.regola !== null);
  const scartate = recensioni.length - inCoda.length;
  const daFare = inCoda.filter((x) => !ultime.has(x.r.chiave)).length;
  const attive = regole.filter((r) => r.attiva);

  return (
    <main>
      <h1>Automazioni</h1>
      <p className="subtitle">
        {inCoda.length} recensioni in coda, {daFare} mai eseguite — su {recensioni.length} lette
        dalla posta.
      </p>

      {/* Le recensioni escluse non spariscono in silenzio: si dice quante sono
          e per quale motivo restano fuori. */}
      {scartate > 0 && (
        <p className="notice">
          <strong>
            {scartate} recensioni su {recensioni.length} restano fuori dalla coda.
          </strong>{" "}
          In questa fase è attiva una sola regola —{" "}
          {attive.map((r) => r.nome).join(", ") || "nessuna"} — perché stiamo lavorando solo il caso
          più semplice. Le altre regole sono già scritte ma spente: si accendono da{" "}
          <Link href="/impostazioni#automazioni">Impostazioni</Link> una alla volta. Le recensioni
          escluse restano tutte visibili in <Link href="/recensioni">Recensioni</Link>.
        </p>
      )}

      {/* Riga di stato: modalità in vigore e dove si configura il flusso. */}
      <section className={`card modo-riga ${simulazione ? "modo-sim" : "modo-reale"}`}>
        <span className={`conn-badge ${simulazione ? "conn-ok" : "conn-ko"}`}>
          {simulazione ? "simulazione" : "MODALITÀ REALE"}
        </span>
        <span className="modo-riga-testo">
          {simulazione
            ? "Nessuna scrittura verso l'esterno: niente viene modificato su Freshdesk, Google o nella posta."
            : "Le azioni vengono eseguite davvero: ticket modificati ed email inviate."}
        </span>
        <Link href="/impostazioni#automazioni" className="btn-secondary">
          Regole e flussi →
        </Link>
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

      {!graphOk && (
        <section className="card">
          <p className="form-error">Microsoft Graph non è configurato.</p>
        </section>
      )}
      {graphOk && !fdOk && (
        <p className="notice">
          Freshdesk non è configurato: il nodo «Trova il ticket» non troverà nulla.
        </p>
      )}
      {errore && (
        <section className="card">
          <p className="form-error">Errore nella lettura: {errore}</p>
        </section>
      )}

      {/* ------------------------------------------------------- la coda */}
      {inCoda.length === 0 && !errore ? (
        <section className="card">
          <p className="hint">
            Nessuna recensione in coda. Controlla che ci siano regole attive in{" "}
            <Link href="/impostazioni#automazioni">Impostazioni</Link>.
          </p>
        </section>
      ) : (
        <div className="review-grid">
          {inCoda.map(({ r, regola }) => {
            const ultima = ultime.get(r.chiave);
            const anteprima = regola!.azioni.find((a) => a.tipo === "google.rispondi");
            const conTesto = haTesto(r);

            return (
              <article key={r.chiave} className={`review-card ${ultima ? "gia-eseguita" : ""}`}>
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
                  <span className="flag flag-green">{regola!.nome}</span>
                  <span className="flag flag-gray">{regola!.azioni.length} passaggi</span>
                  {ultima && (
                    <span className={`flag ${ultima.esito === "errore" ? "flag-red" : "flag-gray"}`}>
                      eseguita {fmt.format(new Date(ultima.quando))}
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
                    >
                      {simulazione ? "Esegui simulazione" : "Esegui davvero"}
                    </button>
                  </form>
                  {ultima && (
                    <>
                      <Link className="btn-mini" href={`/automazioni?run=${ultima.id}`}>
                        Ultimo esito →
                      </Link>
                      <form action={eliminaEsecuzioneAction}>
                        <input type="hidden" name="id" value={ultima.id} />
                        <button type="submit" className="btn-mini btn-danger">
                          Cancella prova
                        </button>
                      </form>
                    </>
                  )}
                  <Link className="btn-mini" href={`/email?id=${encodeURIComponent(r.messaggioId)}`}>
                    Email →
                  </Link>
                </footer>
              </article>
            );
          })}
        </div>
      )}

      {/* -------------------------------------------------------- registro */}
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
                    <td className="thread-actions">
                      <Link className="btn-mini" href={`/automazioni?run=${e.id}`}>
                        Dettaglio
                      </Link>
                      <form action={eliminaEsecuzioneAction}>
                        <input type="hidden" name="id" value={e.id} />
                        <button type="submit" className="btn-mini btn-danger">
                          Cancella
                        </button>
                      </form>
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
