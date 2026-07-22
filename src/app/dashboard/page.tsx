import Link from "next/link";
import { testoPerRecensione } from "@/server/automation/connectors";
import { caricaRegole, regolaPer } from "@/server/automation/rules";
import { caricaEsecuzioni, ultimePerRecensione } from "@/server/automation/runs";
import type { Azione, Esecuzione, Regola } from "@/server/automation/types";
import { isGraphConfigured } from "@/server/graph/client";
import { isFreshdeskConfigured } from "@/server/integrations/freshdesk";
import { caricaRecensioni, haTesto, testoRecensione, type Recensione } from "@/server/reviews/load";
import { loadSettings } from "@/server/settings";
import { isTranslationConfigured } from "@/server/translate";
import { approvaAction, inoltraAction, rimettiInCodaAction } from "./actions";

// Dashboard operativa: una sola schermata per lavorare le recensioni.
//
//   sinistra  — già lavorate: la risposta è partita (o sarebbe partita)
//   centro    — da gestire: la coda vera, con la risposta proposta
//   destra    — in attesa del customer care: inoltrate, palla al collega
//
// I dati sono sempre quelli veri letti dalla posta. A cambiare è solo cosa
// succede quando si preme un pulsante, e lo decide la modalità operativa:
// in simulazione il flusso gira per intero ma nessuna chiamata parte davvero.

export const dynamic = "force-dynamic";
export const metadata = { title: "Dashboard — Galdieri rent" };

const fmt = new Intl.DateTimeFormat("it-IT", { dateStyle: "medium", timeStyle: "short" });
const fmtBreve = new Intl.DateTimeFormat("it-IT", { day: "2-digit", month: "short" });

/** Il nodo che scrive la risposta al cliente: è quello che si mostra e si può riscrivere. */
function nodoRisposta(regola: Regola): Azione | null {
  return (
    regola.azioni.find((a) => a.tipo === "google.rispondi") ??
    regola.azioni.find((a) => a.tipo === "email.rispondi") ??
    null
  );
}

/** Un flusso fermo in attesa di una persona non è concluso: va nella colonna di destra. */
function inAttesa(e: Esecuzione): boolean {
  return e.nodi.some((n) => n.tipo === "sistema.attendiRisposta");
}

function Stelle({ n }: { n: number | null }) {
  const v = n ?? 0;
  return (
    <span className={`stars-badge stars-${v}`} title={n ? `${n} su 5` : "senza punteggio"}>
      {"★".repeat(v)}
      <span className="stars-empty">{"★".repeat(5 - v)}</span>
    </span>
  );
}

/** Scheda compatta delle colonne laterali. */
function SchedaLaterale({
  e,
  stelleSel,
  tono,
  stato,
}: {
  e: Esecuzione;
  stelleSel: number | null;
  tono: "fatta" | "attesa";
  stato: string;
}) {
  return (
    <article className="dash-mini">
      <div className="dash-mini-head">
        <span className="dash-mini-name">{e.recensione.nome}</span>
        <span className="dash-mini-date">{fmtBreve.format(new Date(e.quando))}</span>
      </div>
      <p className="dash-mini-text">{e.recensione.testo || "— senza commento —"}</p>
      <div className="dash-mini-foot">
        <span className={`dash-dot dash-dot-${tono}`} aria-hidden="true" />
        <span className={`dash-mini-stato dash-stato-${tono}`}>{stato}</span>
        {e.testoModificato && <span className="flag flag-gray">testo riscritto</span>}
      </div>
      <div className="dash-mini-actions">
        <Link className="btn-mini" href={`/automazioni?run=${e.id}`}>
          Dettaglio →
        </Link>
        <form action={rimettiInCodaAction}>
          <input type="hidden" name="id" value={e.id} />
          <input type="hidden" name="stelle" value={stelleSel ?? ""} />
          <button type="submit" className="btn-mini btn-danger">
            Rimetti in coda
          </button>
        </form>
      </div>
    </article>
  );
}

function href(stelle?: number | null): string {
  return stelle ? `/dashboard?stelle=${stelle}` : "/dashboard";
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ stelle?: string; run?: string; errore?: string }>;
}) {
  const sp = await searchParams;
  const settings = await loadSettings();
  const label = settings.labels[0] ?? null;
  const simulazione = settings.modo !== "reale";

  const [regole, esecuzioni, graphOk, fdOk, traduzioneOk] = await Promise.all([
    caricaRegole(),
    caricaEsecuzioni(),
    isGraphConfigured(),
    isFreshdeskConfigured(),
    isTranslationConfigured(),
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
  const lavorate = [...ultime.values()];
  const fatte = lavorate.filter((e) => !inAttesa(e));
  const attesa = lavorate.filter(inAttesa);

  // Da gestire = tutto ciò che non è ancora stato toccato. Anche le recensioni
  // che nessuna regola copre restano qui: non si possono approvare, ma si
  // possono sempre inoltrare — sparire in silenzio sarebbe peggio.
  const daGestire = recensioni
    .filter((r) => !ultime.has(r.chiave))
    .map((r) => ({ r, regola: regolaPer(regole, r.stelle, haTesto(r)) }));

  const conteggi: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const { r } of daGestire) {
    if (r.stelle && conteggi[r.stelle] !== undefined) conteggi[r.stelle] += 1;
  }

  const stelleNum = Number(sp.stelle);
  const stelleSel = stelleNum >= 1 && stelleNum <= 5 ? stelleNum : null;
  const coda = stelleSel ? daGestire.filter((x) => x.r.stelle === stelleSel) : daGestire;

  const runAperta = sp.run ? esecuzioni.find((e) => e.id === sp.run) : undefined;

  return (
    <main className="dash">
      <header className="dash-testa">
        <div>
          <h1>Dashboard</h1>
          <p className="subtitle">
            {label ? label.name : "nessuna etichetta"} — {daGestire.length} da gestire,{" "}
            {fatte.length} lavorate, {attesa.length} in attesa del customer care
            {stelleSel ? ` · filtro ${stelleSel}★` : ""}
          </p>
        </div>
        <div className="dash-stato-servizi">
          <span className={`conn-badge ${graphOk ? "conn-ok" : "conn-ko"}`}>
            {graphOk ? "posta collegata" : "posta da configurare"}
          </span>
          <span className={`conn-badge ${fdOk ? "conn-ok" : "conn-ko"}`}>
            {fdOk ? "Freshdesk collegato" : "Freshdesk da configurare"}
          </span>
          <span className={`conn-badge ${traduzioneOk ? "conn-ok" : "conn-ko"}`}>
            {traduzioneOk ? "traduzione attiva" : "traduzione spenta"}
          </span>
        </div>
      </header>

      {/* Che cosa succede davvero premendo i pulsanti. Sempre in vista. */}
      <section className={`card modo-riga ${simulazione ? "modo-sim" : "modo-reale"}`}>
        <span className={`conn-badge ${simulazione ? "conn-ok" : "conn-ko"}`}>
          {simulazione ? "simulazione" : "MODALITÀ REALE"}
        </span>
        <span className="modo-riga-testo">
          {simulazione
            ? "Recensioni vere, azioni finte: il flusso gira per intero ma niente viene scritto su Freshdesk, Google o nella posta."
            : "Le azioni partono davvero: ticket modificati, risposte pubblicate ed email inviate."}
        </span>
        <Link href="/impostazioni#automazioni" className="btn-secondary">
          Regole e modalità →
        </Link>
      </section>

      {sp.errore && (
        <section className="card">
          <p className="form-error">
            {sp.errore === "nessuna-regola"
              ? "Nessuna regola attiva copre questa recensione: puoi solo inoltrarla al customer care."
              : "Recensione non trovata: potrebbe essere uscita dalle ultime 50 email."}
          </p>
        </section>
      )}

      {runAperta && (
        <section className={`card run-card ${runAperta.esito === "errore" ? "run-card-ko" : ""}`}>
          <div className="sec-head">
            <h2>
              {runAperta.recensione.nome} — {runAperta.regolaNome}
            </h2>
            <Link className="btn-mini" href={`/automazioni?run=${runAperta.id}`}>
              Flusso completo →
            </Link>
          </div>
          <p className="hint">
            {fmt.format(new Date(runAperta.quando))} ·{" "}
            {runAperta.modo === "reale" ? "eseguita davvero" : "simulata, nulla è stato scritto"} ·{" "}
            {runAperta.nodi.length} passaggi
          </p>
          <ul className="dash-riepilogo">
            {runAperta.nodi.map((n) => (
              <li key={n.azioneId} className={`dash-nodo dash-nodo-${n.stato}`}>
                <strong>{n.titolo}</strong> — {n.messaggio}
              </li>
            ))}
          </ul>
        </section>
      )}

      {!graphOk && (
        <section className="card">
          <p className="form-error">
            Microsoft Graph non è configurato: senza posta non ci sono recensioni da mostrare.
          </p>
        </section>
      )}
      {errore && (
        <section className="card">
          <p className="form-error">Errore nella lettura della posta: {errore}</p>
        </section>
      )}

      <div className="dash-colonne">
        {/* ------------------------------------------------ colonna sinistra */}
        <aside className="dash-col">
          <div className="dash-col-testa">
            <span className="dash-col-titolo">
              {simulazione ? "Lavorate · simulate" : "Lavorate · inviate"}
            </span>
            <span className="dash-conteggio dash-conteggio-fatta">{fatte.length}</span>
          </div>
          <p className="dash-col-nota">
            {simulazione
              ? "Risposta pronta e flusso verificato, ma non pubblicata."
              : "Risposta pubblicata e ticket lavorato."}
          </p>
          {fatte.length === 0 ? (
            <p className="hint">Ancora nessuna.</p>
          ) : (
            fatte.map((e) => (
              <SchedaLaterale
                key={e.id}
                e={e}
                stelleSel={stelleSel}
                tono="fatta"
                stato={
                  e.esito === "errore"
                    ? "flusso interrotto da un errore"
                    : e.modo === "reale"
                      ? "risposta pubblicata"
                      : "risposta simulata"
                }
              />
            ))
          )}
        </aside>

        {/* --------------------------------------------------------- centro */}
        <section className="dash-centro">
          <div className="dash-centro-testa">
            <div>
              <h2>Da gestire</h2>
              <p className="hint">
                {coda.length} recensioni in attesa di una tua decisione
                {stelleSel ? ` fra quelle da ${stelleSel}★` : ""}
              </p>
            </div>
          </div>

          {daGestire.length > 0 && (
            <div className="star-filter">
              <Link
                href={href(null)}
                className={`star-chip chip-all${stelleSel ? "" : " is-active"}`}
              >
                Tutte <span className="chip-count">{daGestire.length}</span>
              </Link>
              {[1, 2, 3, 4, 5].map((n) => {
                const attivo = stelleSel === n;
                return (
                  <Link
                    key={n}
                    href={attivo ? href(null) : href(n)}
                    className={`star-chip s${n}${attivo ? " is-active" : ""}${
                      conteggi[n] === 0 ? " is-empty" : ""
                    }`}
                    aria-label={`${conteggi[n]} recensioni da ${n} stelle da gestire`}
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

          {coda.length === 0 ? (
            <section className="card dash-vuoto">
              {daGestire.length === 0
                ? "Tutto gestito. Nessuna recensione in attesa."
                : `Nessuna recensione da ${stelleSel}★ da gestire.`}
            </section>
          ) : (
            coda.map(({ r, regola }) => {
              const nodo = regola ? nodoRisposta(regola) : null;
              const suggerito = nodo ? testoPerRecensione(nodo, r) : null;
              const testo = testoRecensione(r);
              const mostraOriginale = Boolean(
                r.originale && !r.giaItaliano && r.originale !== testo,
              );

              return (
                <article key={r.chiave} className="card dash-card">
                  <header className="dash-card-testa">
                    <div className="dash-autore">
                      <span className="dash-iniziale" aria-hidden="true">
                        {(r.nome || "?").trim().charAt(0).toUpperCase()}
                      </span>
                      <div>
                        <div className="dash-autore-riga">
                          <span className="review-name">{r.nome || "senza nome"}</span>
                          {label && <span className="dash-fonte">{label.name}</span>}
                          {r.lingua && r.lingua !== "it" && (
                            <span className="dash-lingua">{r.lingua.toUpperCase()}</span>
                          )}
                        </div>
                        <div className="dash-meta">
                          {fmt.format(new Date(r.ricevutaIl))}
                          {r.sede ? ` · ${r.sede}` : ""}
                        </div>
                      </div>
                    </div>
                    <Stelle n={r.stelle} />
                  </header>

                  <p className={`review-comment ${testo ? "" : "muted"}`}>
                    {testo || "— nessun commento, solo punteggio —"}
                  </p>

                  {mostraOriginale && (
                    <details className="review-original">
                      <summary>
                        Testo originale del cliente
                        {r.lingua ? ` (${r.lingua.toUpperCase()})` : ""}
                      </summary>
                      <p>{r.originale}</p>
                    </details>
                  )}

                  {regola && suggerito ? (
                    <form action={approvaAction} className="dash-proposta">
                      <div className="dash-proposta-testa">
                        Risposta prevista dalla regola «{regola.nome}»
                        <span className="muted"> · {regola.azioni.length} passaggi</span>
                      </div>
                      <input type="hidden" name="chiave" value={r.chiave} />
                      <input type="hidden" name="label" value={label?.id ?? ""} />
                      <input type="hidden" name="stelle" value={stelleSel ?? ""} />
                      <input type="hidden" name="azioneId" value={nodo!.id} />
                      <input type="hidden" name="testoOriginale" value={suggerito.testo} />
                      {/* Il testo è sempre modificabile: quello che si legge è
                          quello che parte. */}
                      <textarea
                        name="testo"
                        className="dash-testo"
                        rows={suggerito.testo.length > 120 ? 4 : 2}
                        defaultValue={suggerito.testo}
                        aria-label="Testo della risposta"
                      />
                      <div className="dash-azioni">
                        <button
                          type="submit"
                          className={simulazione ? "btn-primary" : "btn-primary btn-danger"}
                        >
                          {simulazione ? "Approva (simulazione)" : "Approva e pubblica"}
                        </button>
                      </div>
                    </form>
                  ) : (
                    <p className="notice dash-senza-regola">
                      Nessuna regola attiva copre questa recensione: si può solo inoltrare al
                      customer care, oppure accendere una regola da{" "}
                      <Link href="/impostazioni#automazioni">Impostazioni</Link>.
                    </p>
                  )}

                  <footer className="dash-piede">
                    <form action={inoltraAction}>
                      <input type="hidden" name="chiave" value={r.chiave} />
                      <input type="hidden" name="label" value={label?.id ?? ""} />
                      <input type="hidden" name="stelle" value={stelleSel ?? ""} />
                      <button type="submit" className="btn-secondary">
                        Inoltra al customer care →
                      </button>
                    </form>
                    <Link
                      className="btn-mini"
                      href={`/email?id=${encodeURIComponent(r.messaggioId)}`}
                    >
                      Vedi l&apos;email
                    </Link>
                    {r.haRisposta && <span className="flag flag-green">già risposta in posta</span>}
                    {r.risolto && <span className="flag flag-gray">ticket risolto</span>}
                  </footer>
                </article>
              );
            })
          )}
        </section>

        {/* -------------------------------------------------- colonna destra */}
        <aside className="dash-col">
          <div className="dash-col-testa">
            <span className="dash-col-titolo">In attesa · customer care</span>
            <span className="dash-conteggio dash-conteggio-attesa">{attesa.length}</span>
          </div>
          <p className="dash-col-nota">
            Inoltrate: il flusso riparte quando risponde il collega.
          </p>
          {attesa.length === 0 ? (
            <p className="hint">Nessuna in attesa.</p>
          ) : (
            attesa.map((e) => (
              <SchedaLaterale
                key={e.id}
                e={e}
                stelleSel={stelleSel}
                tono="attesa"
                stato={
                  e.esito === "errore" ? "flusso interrotto da un errore" : "attende una risposta"
                }
              />
            ))
          )}
        </aside>
      </div>
    </main>
  );
}
