import Link from "next/link";
import { testoPerRecensione } from "@/server/automation/connectors";
import { caricaRegole, regolaPer } from "@/server/automation/rules";
import { caricaEsecuzioni, ultimePerRecensione } from "@/server/automation/runs";
import type { Azione, Regola } from "@/server/automation/types";
import { isGraphConfigured } from "@/server/graph/client";
import { caricaRecensioni, haTesto, testoRecensione, type Recensione } from "@/server/reviews/load";
import {
  codaDaPubblicare,
  codaDaRicontrollare,
  ORE_RICONTROLLO,
  type VocePubblicazione,
} from "@/server/db/pubblicazioni";
import { ritentaChiusureInSospeso } from "@/server/pubblicazione";
import { isFreshdeskConfigured } from "@/server/integrations/freshdesk";
import { loadSettings } from "@/server/settings";
import { approvaAction, inoltraAction } from "./dashboard/actions";
import { Stelle, VoceCoda, VoceRicontrollo } from "./da-pubblicare/Voci";
import { TastieraCoda } from "./da-pubblicare/TastieraCoda";

// La home è la pipeline completa di una recensione, in un'unica pagina a tre
// passi:
//
//   Da approvare    — la recensione arriva dalla posta, si approva il «Grazie.»
//   Da pubblicare   — la risposta approvata si incolla a mano su Google
//   Da ricontrollare — dopo 24h si verifica che sia rimasta online
//
// I conteggi dei tab raccontano il flusso da sinistra a destra. Al momento si
// lavorano solo le recensioni 5★ senza commento: tutto il resto è filtrato via.
//
// La lettura della posta (Microsoft Graph) è lenta e si fa solo sul tab «Da
// approvare»: così pubblicare e ricontrollare — dove si lavora a raffica da
// tastiera — restano immediati e non aspettano la posta a ogni Invio.

export const dynamic = "force-dynamic";
export const metadata = { title: "GaldieriReviews" };

const fmt = new Intl.DateTimeFormat("it-IT", { dateStyle: "medium", timeStyle: "short" });

type Passo = "approvare" | "pubblicare" | "ricontrollo";

/** Al momento si mostrano solo le recensioni a 5 stelle senza commento. */
function soloCinqueSenzaCommento(v: VocePubblicazione): boolean {
  return v.stelle === 5 && !v.testoRecensione;
}

/** Il nodo che scrive la risposta al cliente: è quello che si mostra e si può riscrivere. */
function nodoRisposta(regola: Regola): Azione | null {
  return (
    regola.azioni.find((a) => a.tipo === "google.rispondi") ??
    regola.azioni.find((a) => a.tipo === "email.rispondi") ??
    null
  );
}

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ step?: string; sede?: string; run?: string; errore?: string }>;
}) {
  const sp = await searchParams;
  const step: Passo =
    sp.step === "pubblicare"
      ? "pubblicare"
      : sp.step === "ricontrollo"
        ? "ricontrollo"
        : "approvare";

  const settings = await loadSettings();
  const simulazione = settings.modo !== "reale";

  // Code di pubblicazione: letture Mongo veloci, si caricano sempre così i tab
  // hanno i conteggi e la pubblicazione a raffica resta immediata. All'apertura
  // si ritentano, best-effort, le chiusure Freshdesk rimaste in sospeso.
  await ritentaChiusureInSospeso();
  const [codaPubAll, codaRicAll, fdOk] = await Promise.all([
    codaDaPubblicare(),
    codaDaRicontrollare(),
    isFreshdeskConfigured(),
  ]);
  const codaPub = codaPubAll.filter(soloCinqueSenzaCommento);
  const codaRic = codaRicAll.filter(soloCinqueSenzaCommento);

  // Filtro per sede sul tab «Da pubblicare» (le stelle non servono: sono tutte 5).
  const sedi = [...new Set(codaPub.map((v) => v.sedeNome).filter(Boolean))].sort();
  const sedeSel = sp.sede && sedi.includes(sp.sede) ? sp.sede : null;
  const vociPub = sedeSel ? codaPub.filter((v) => v.sedeNome === sedeSel) : codaPub;

  // --- Da approvare: solo qui si legge la posta (lenta). ---------------------
  const label = settings.labels[0] ?? null;
  let graphOk = true;
  let erroreGraph: string | null = null;
  let daApprovare: { r: Recensione; regola: Regola | null }[] = [];
  let nApprovare: number | null = null;
  let runAperta: ReturnType<typeof trovaRun> = undefined;

  if (step === "approvare") {
    const [regole, esecuzioni, graphConf] = await Promise.all([
      caricaRegole(),
      caricaEsecuzioni(),
      isGraphConfigured(),
    ]);
    graphOk = graphConf;

    let recensioni: Recensione[] = [];
    if (graphOk && label) {
      try {
        recensioni = (await caricaRecensioni(label)).recensioni;
      } catch (e) {
        erroreGraph = e instanceof Error ? e.message : "Errore sconosciuto";
      }
    }

    const ultime = await ultimePerRecensione();
    daApprovare = recensioni
      .filter((r) => !ultime.has(r.chiave))
      .filter((r) => r.stelle === 5 && !haTesto(r))
      .map((r) => ({ r, regola: regolaPer(regole, r.stelle, haTesto(r)) }));
    nApprovare = daApprovare.length;

    runAperta = sp.run ? trovaRun(esecuzioni, sp.run) : undefined;
  }

  return (
    <main className="pipeline">
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

      {/* -------------------------------------------------------------- tab */}
      <nav className="pub-tabs" aria-label="Fasi della pubblicazione">
        <Link href="/" className={`pub-tab${step === "approvare" ? " is-active" : ""}`}>
          Da approvare
          {nApprovare !== null && <span className="chip-count">{nApprovare}</span>}
        </Link>
        <Link
          href="/?step=pubblicare"
          className={`pub-tab${step === "pubblicare" ? " is-active" : ""}`}
        >
          Da pubblicare <span className="chip-count">{codaPub.length}</span>
        </Link>
        <Link
          href="/?step=ricontrollo"
          className={`pub-tab${step === "ricontrollo" ? " is-active" : ""}`}
        >
          Da ricontrollare <span className="chip-count">{codaRic.length}</span>
        </Link>
      </nav>

      {/* =================================================== Da approvare === */}
      {step === "approvare" && (
        <section className="dash-centro">
          <div className="dash-centro-testa">
            <div>
              <h2>Da approvare</h2>
              <p className="hint">
                {daApprovare.length} recensioni 5★ senza commento in attesa di una tua decisione
              </p>
            </div>
          </div>

          {!graphOk && (
            <section className="card">
              <p className="form-error">
                Microsoft Graph non è configurato: senza posta non ci sono recensioni da mostrare.
              </p>
            </section>
          )}
          {erroreGraph && (
            <section className="card">
              <p className="form-error">Errore nella lettura della posta: {erroreGraph}</p>
            </section>
          )}

          {daApprovare.length === 0 ? (
            <section className="card dash-vuoto">
              Nessuna recensione 5★ senza commento da approvare.
            </section>
          ) : (
            daApprovare.map(({ r, regola }) => {
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
      )}

      {/* ================================================== Da pubblicare === */}
      {step === "pubblicare" && (
        <section className="dash-centro">
          <div className="dash-centro-testa">
            <div>
              <h2>Da pubblicare</h2>
              <p className="hint">
                {vociPub.length} risposte pronte da incollare su Google
                {sedeSel ? ` · ${sedeSel}` : ""}
              </p>
            </div>
            <Link href="/sedi" className="btn-secondary">
              Link delle sedi →
            </Link>
          </div>

          <section className={`card modo-riga ${simulazione ? "modo-sim" : "modo-reale"}`}>
            <span className={`conn-badge ${simulazione ? "conn-ok" : "conn-ko"}`}>
              {simulazione ? "simulazione" : "MODALITÀ REALE"}
            </span>
            <span className="modo-riga-testo">
              {simulazione
                ? "«Segna come pubblicata» sposta la risposta nel ricontrollo, ma il ticket NON viene chiuso su Freshdesk."
                : "«Segna come pubblicata» chiude anche il ticket collegato su Freshdesk."}
            </span>
            {!fdOk && <span className="conn-badge conn-ko">Freshdesk da configurare</span>}
            <Link href="/impostazioni#modo" className="btn-secondary">
              Modalità →
            </Link>
          </section>

          {sedi.length > 1 && (
            <div className="pub-sedi">
              <Link href="/?step=pubblicare" className={`btn-mini${sedeSel ? "" : " is-active"}`}>
                Tutte le sedi
              </Link>
              {sedi.map((s) => (
                <Link
                  key={s}
                  href={
                    sedeSel === s
                      ? "/?step=pubblicare"
                      : `/?step=pubblicare&sede=${encodeURIComponent(s)}`
                  }
                  className={`btn-mini${sedeSel === s ? " is-active" : ""}`}
                >
                  {s}
                </Link>
              ))}
            </div>
          )}

          {vociPub.length === 0 ? (
            <section className="card dash-vuoto">
              {codaPub.length === 0
                ? "Nessuna risposta in attesa di pubblicazione. Le risposte approvate qui sopra compaiono in questo tab."
                : "Nessuna risposta con questi filtri."}
            </section>
          ) : (
            <>
              <TastieraCoda />
              <ol className="pub-lista">
                {vociPub.map((v, i) => (
                  <VoceCoda
                    key={v.chiave}
                    v={v}
                    numero={i + 1}
                    sedeSel={sedeSel}
                    stelleSel={null}
                  />
                ))}
              </ol>
            </>
          )}
        </section>
      )}

      {/* ================================================ Da ricontrollare === */}
      {step === "ricontrollo" && (
        <section className="dash-centro">
          <div className="dash-centro-testa">
            <div>
              <h2>Da ricontrollare</h2>
              <p className="hint pub-ricontrollo-nota">
                Le risposte pubblicate su Google a volte non risultano salvate. Dopo{" "}
                {ORE_RICONTROLLO} ore si riaprono qui: controlla che la risposta ci sia e conferma,
                oppure rimettila in coda se è sparita.
              </p>
            </div>
          </div>

          {codaRic.length === 0 ? (
            <section className="card dash-vuoto">Niente da ricontrollare.</section>
          ) : (
            <ol className="pub-lista">
              {codaRic.map((v, i) => (
                <VoceRicontrollo key={v.chiave} v={v} numero={i + 1} />
              ))}
            </ol>
          )}
        </section>
      )}
    </main>
  );
}

// --- helper ----------------------------------------------------------------

type Esec = Awaited<ReturnType<typeof caricaEsecuzioni>>[number];

/** L'esecuzione appena conclusa da mostrare in cima (feedback dopo l'approvazione). */
function trovaRun(esecuzioni: Esec[], id: string): Esec | undefined {
  return esecuzioni.find((e) => e.id === id);
}
