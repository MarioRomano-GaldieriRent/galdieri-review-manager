import Link from "next/link";
import { isGraphConfigured } from "@/server/graph/client";
import { isFreshdeskConfigured } from "@/server/integrations/freshdesk";
import { caricaRegole, regolaPer } from "@/server/automation/rules";
import { caricaEsecuzioni, ultimePerRecensione } from "@/server/automation/runs";
import type { Esecuzione } from "@/server/automation/types";
import { testoPerRecensione } from "@/server/automation/connectors";
import { tagSede } from "@/server/automation/sedi";
import { caricaRecensioni, haTesto, testoRecensione, type Recensione } from "@/server/reviews/load";
import { loadSettings } from "@/server/settings";
import { NodoEseguito } from "../_ui/automazioni";
import { eliminaEsecuzioneAction, eseguiSuRecensioneAction, svuotaRegistroAction } from "./actions";

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

/** Indirizzo del pannello conservando il filtro attivo. */
function href(stelle?: number | null, run?: string): string {
  const p = new URLSearchParams();
  if (stelle) p.set("stelle", String(stelle));
  if (run) p.set("run", run);
  const s = p.toString();
  return s ? `/automazioni?${s}` : "/automazioni";
}

export default async function AutomazioniPage({
  searchParams,
}: {
  searchParams: Promise<{ run?: string; errore?: string; stelle?: string }>;
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
  const tuttaLaCoda = recensioni
    .map((r) => ({ r, regola: regolaPer(regole, r.stelle, haTesto(r)) }))
    .filter((x) => x.regola !== null);
  const scartate = recensioni.length - tuttaLaCoda.length;
  const attive = regole.filter((r) => r.attiva);

  // Filtro per stelle. I conteggi si calcolano SEMPRE sull'intera coda, così i
  // livelli restano visibili anche quando un filtro è attivo.
  const stelleNum = Number(sp.stelle);
  const stelleSel = stelleNum >= 1 && stelleNum <= 5 ? stelleNum : null;
  const conteggi: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const { r } of tuttaLaCoda) {
    if (r.stelle && conteggi[r.stelle] !== undefined) conteggi[r.stelle] += 1;
  }

  const inCoda = stelleSel ? tuttaLaCoda.filter((x) => x.r.stelle === stelleSel) : tuttaLaCoda;
  const daFare = inCoda.filter((x) => !ultime.has(x.r.chiave)).length;

  return (
    <main>
      <h1>Automazioni</h1>
      <p className="subtitle">
        {inCoda.length} recensioni in coda, {daFare} mai eseguite — su {recensioni.length} lette
        dalla posta
        {stelleSel ? ` · filtro ${stelleSel}★` : ""}
      </p>

      {/* Le recensioni escluse non spariscono in silenzio: si dice quante sono
          e per quale motivo restano fuori. */}
      {scartate > 0 && (
        <p className="notice">
          <strong>
            {scartate} recensioni su {recensioni.length} restano fuori dalla coda.
          </strong>{" "}
          Nessuna regola attiva le copre. Attive adesso:{" "}
          {attive.map((r) => r.nome).join(", ") || "nessuna"}. Le altre sono già scritte ma spente e
          si accendono da <Link href="/impostazioni#automazioni">Impostazioni</Link> una alla volta.
          Le recensioni escluse restano tutte visibili nella <Link href="/">Dashboard</Link>.
        </p>
      )}

      {/* Filtro per stelle: serve a simulare un livello alla volta. */}
      {tuttaLaCoda.length > 0 && (
        <div className="star-filter">
          <Link href={href(null)} className={`star-chip chip-all${stelleSel ? "" : " is-active"}`}>
            Tutte <span className="chip-count">{tuttaLaCoda.length}</span>
          </Link>
          {[1, 2, 3, 4, 5].map((n) => {
            const attivo = stelleSel === n;
            return (
              <Link
                key={n}
                href={attivo ? href(null) : href(n)}
                className={`star-chip s${n}${attivo ? " is-active" : ""}${conteggi[n] === 0 ? " is-empty" : ""}`}
                aria-label={`${conteggi[n]} recensioni da ${n} stelle in coda`}
              >
                <span className="chip-stars">
                  {"★".repeat(n)}
                  <span className="stars-empty">{"★".repeat(5 - n)}</span>
                </span>
                <span className="chip-count">{conteggi[n]}</span>
              </Link>
            );
          })}
        </div>
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
            {stelleSel ? (
              <>
                Nessuna recensione da {stelleSel}★ in coda.{" "}
                <Link href={href(null)}>Togli il filtro</Link> per vedere le altre.
              </>
            ) : (
              <>
                Nessuna recensione in coda. Controlla che ci siano regole attive in{" "}
                <Link href="/impostazioni#automazioni">Impostazioni</Link>.
              </>
            )}
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
                    <span
                      className={`flag ${ultima.esito === "errore" ? "flag-red" : "flag-gray"}`}
                    >
                      eseguita {fmt.format(new Date(ultima.quando))}
                    </span>
                  )}
                </div>

                {anteprima && (
                  <details className="review-original">
                    <summary>Risposta che verrebbe pubblicata su Google</summary>
                    {/* Deve mostrare la lingua che partirebbe davvero: italiano o
                        inglese secondo la regola a due vie. Prendere il campo
                        `testo` grezzo mostrerebbe sempre l'italiano, anche quando
                        al cliente straniero verrebbe pubblicato l'inglese. */}
                    <p>{testoPerRecensione(anteprima, r).testo}</p>
                  </details>
                )}

                <footer className="review-foot">
                  <form action={eseguiSuRecensioneAction}>
                    <input type="hidden" name="chiave" value={r.chiave} />
                    <input type="hidden" name="label" value={label?.id ?? ""} />
                    <input type="hidden" name="stelle" value={stelleSel ?? ""} />
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
                  <Link
                    className="btn-mini"
                    href={`/email?id=${encodeURIComponent(r.messaggioId)}`}
                  >
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
                      <Link className="btn-mini" href={href(stelleSel, e.id)}>
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
