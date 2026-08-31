import Link from "next/link";
import { testoPerRecensione } from "@/server/automation/connectors";
import { caricaRegole, regolaPer } from "@/server/automation/rules";
import { caricaEsecuzioni } from "@/server/automation/runs";
import type { Azione, Regola } from "@/server/automation/types";
import { isGraphConfigured } from "@/server/graph/client";
import { chiaviRisolteDaFreshdesk } from "@/server/integrations/freshdesk";
import { caricaRecensioni, haTesto, testoRecensione, type Recensione } from "@/server/reviews/load";
import {
  chiaviPubblicate,
  codaDaPubblicare,
  storicoPubblicazioni,
  type VocePubblicazione,
} from "@/server/db/pubblicazioni";
import { ritentaChiusureInSospeso } from "@/server/pubblicazione";
import { isFreshdeskConfigured } from "@/server/integrations/freshdesk";
import { loadSettings } from "@/server/settings";
import { apriGoogleAction, playAction } from "./dashboard/actions";
import { VediMail } from "./VediMail";
import { AutoAggiorna } from "./AutoAggiorna";
import { AnteprimaFlusso } from "./AnteprimaFlusso";
import { PassoAnteprima } from "./_ui/automazioni";
import { Stelle, VoceCoda, VoceStorico } from "./da-pubblicare/Voci";
import { TastieraCoda } from "./da-pubblicare/TastieraCoda";

// La home è la pipeline di una recensione, in un'unica pagina:
//
//   Da approvare — la recensione arriva dalla posta; col tasto «Rispondi» il
//                  robot pubblica su Google e partono email/Freshdesk.
//   Storico      — sola lettura: la cronologia delle risposte già pubblicate
//                  dal nostro sito (nessuna azione, solo informazioni).
//   (Da pubblicare resta come vista di ripiego raggiungibile solo via URL.)
//
// Al momento si lavorano solo le recensioni 5★ senza commento: tutto il resto
// è filtrato via.
//
// La lettura della posta (Microsoft Graph) è lenta e si fa solo sul tab «Da
// approvare»: così pubblicare e ricontrollare — dove si lavora a raffica da
// tastiera — restano immediati e non aspettano la posta a ogni Invio.

export const dynamic = "force-dynamic";
export const metadata = { title: "GaldieriReviews" };

const fmt = new Intl.DateTimeFormat("it-IT", { dateStyle: "medium", timeStyle: "short" });
const oraFmt = new Intl.DateTimeFormat("it-IT", { hour: "2-digit", minute: "2-digit" });

// Data con il giorno della settimana e il mese per esteso: "Venerdì 28 agosto
// 2026". Intl in italiano restituisce il giorno minuscolo, quindi si mette la
// maiuscola iniziale.
const fmtGiorno = new Intl.DateTimeFormat("it-IT", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});
function dataConGiorno(d: Date): string {
  const s = fmtGiorno.format(d);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Il logo "G" di Google a 4 colori, per il tasto che apre il robot. */
function GoogleG() {
  return (
    <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

/** Icona "refresh" (due frecce circolari), adatta al tema (usa currentColor). */
function IconaAggiorna() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}

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
  searchParams: Promise<{
    step?: string;
    sede?: string;
    run?: string;
    errore?: string;
    esitoOk?: string;
    esitoMsg?: string;
    esitoChiave?: string;
    fresh?: string;
  }>;
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

  // Ora del render = ultimo aggiornamento dei dati. La pagina è force-dynamic e
  // si ri-renderizza a ogni caricamento/refresh, quindi questo valore è sempre
  // "l'ultima volta che la vista si è aggiornata" (mostrato nel tooltip dell'icona).
  const aggiornatoAlle = oraFmt.format(new Date());

  // Code di pubblicazione: letture Mongo veloci, si caricano sempre così i tab
  // hanno i conteggi e la pubblicazione a raffica resta immediata. All'apertura
  // si ritentano, best-effort, le chiusure Freshdesk rimaste in sospeso.
  await ritentaChiusureInSospeso();
  const [codaPubAll, storicoAll, fdOk] = await Promise.all([
    codaDaPubblicare(),
    storicoPubblicazioni(),
    isFreshdeskConfigured(),
  ]);
  const codaPub = codaPubAll.filter(soloCinqueSenzaCommento);
  // Lo storico è la cronologia completa delle risposte pubblicate dal sito.
  const storico = storicoAll;

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

    // Lista UNICA: le recensioni ancora da pubblicare su Google. Sparisce solo
    // ciò che è già stato pubblicato (stato pubblicata/verificata); quelle
    // "approvata" ma non ancora pubblicate (robot non riuscito) restano qui per
    // riprovare col Play. Guidata dalle regole ATTIVE: oggi solo "5★ senza
    // commento", accendendone altre in Impostazioni compaiono anche le loro.
    const pubblicate = await chiaviPubblicate();
    daApprovare = recensioni
      // Fuori dall'elenco:
      //  - ciò che abbiamo già pubblicato noi (stato pubblicata/verificata);
      //  - ciò a cui ha GIÀ RISPOSTO l'operatore a mano — nel thread c'è una
      //    risposta di una persona @galdierirent.it (haRisposta). È gestita fuori
      //    dal nostro flusso: non c'è niente da approvare, e non finisce nemmeno
      //    nello Storico, che raccoglie solo le risposte pubblicate DAL sito.
      .filter((r) => !pubblicate.has(r.chiave) && !r.haRisposta)
      .map((r) => ({ r, regola: regolaPer(regole, r.stelle, haTesto(r)) }))
      .filter((x) => x.regola !== null);

    // «Aggiorna» (tasto di pagina): verifica su Freshdesk e toglie le recensioni
    // il cui ticket è stato risolto/chiuso da qualcun altro — così se qualcuno
    // fuori lavora un ticket, il conteggio scende (4→3). UNA sola lettura della
    // lista ticket, condivisa da tutte le recensioni (niente fan-out N×).
    if (sp.fresh === "1") {
      try {
        const risolte = await chiaviRisolteDaFreshdesk(
          daApprovare.map((x) => ({
            chiave: x.r.chiave,
            oggetto: x.r.oggetto,
            ricevutaIl: x.r.ricevutaIl,
          })),
        );
        daApprovare = daApprovare.filter((x) => !risolte.has(x.r.chiave));
      } catch {
        // Freshdesk non raggiungibile: non nascondo nulla, resta tutto in lista.
      }
    }
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

      {sp.esitoMsg && (
        <section className="card">
          <p className={sp.esitoOk === "1" ? "" : "form-error"}>
            {sp.esitoOk === "1" ? "✅ " : "⚠️ "}
            {sp.esitoMsg}
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
        <Link
          href="/"
          className={`pub-tab${step === "approvare" ? " is-active" : ""}`}
          title="Recensioni coperte dalle regole attive, in attesa di una tua decisione"
        >
          Da approvare
          {nApprovare !== null && <span className="chip-count">{nApprovare}</span>}
        </Link>
        <Link
          href="/?step=ricontrollo"
          className={`pub-tab${step === "ricontrollo" ? " is-active" : ""}`}
          title="Cronologia delle risposte pubblicate dal nostro sito"
        >
          Storico
        </Link>
        <Link
          href={
            step === "approvare"
              ? "/?fresh=1"
              : step === "ricontrollo"
                ? "/?step=ricontrollo"
                : `/?step=pubblicare${sedeSel ? `&sede=${encodeURIComponent(sedeSel)}` : ""}`
          }
          className="pub-aggiorna"
          title={`Ultimo aggiornamento: ${aggiornatoAlle}`}
          aria-label="Aggiorna la vista"
        >
          <IconaAggiorna />
        </Link>
      </nav>

      {/* =================================================== Da approvare === */}
      {step === "approvare" && (
        <section className="dash-centro">
          <AutoAggiorna />

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
              Nessuna recensione da approvare (nessuna coperta dalle regole attive).
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
                          {r.lingua && r.lingua !== "it" && (
                            <span className="dash-lingua">{r.lingua.toUpperCase()}</span>
                          )}
                        </div>
                        <div className="dash-meta">
                          {dataConGiorno(new Date(r.ricevutaIl))}
                          {r.sede ? ` · ${r.sede}` : ""}
                        </div>
                      </div>
                    </div>
                    <div className="dash-scheda">
                      <Stelle n={r.stelle} />
                      {haTesto(r) && (
                        <div className="dash-scheda-chips">
                          <span className="dash-chip">💬 commento</span>
                          {/* 📷 foto: quando l'email porterà l'informazione */}
                        </div>
                      )}
                    </div>
                  </header>

                  {testo && <p className="review-comment">{testo}</p>}

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
                    <form action={playAction} className="dash-proposta">
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
                          className="btn-rispondi"
                          title="Risponde alla recensione: pubblica su Google (col robot), invia l'email e aggiorna il ticket."
                        >
                          Rispondi
                        </button>
                        <AnteprimaFlusso titolo={`Cosa farà su «${r.nome || "questa recensione"}»`}>
                          <ol className="ap-lista">
                            {regola.azioni.map((a) => (
                              <PassoAnteprima key={a.id} azione={a} />
                            ))}
                          </ol>
                        </AnteprimaFlusso>
                        <button
                          type="submit"
                          formAction={apriGoogleAction}
                          className="btn-google"
                          title="Apre la recensione su Google col robot: si ferma lì e decidi tu. Serve Chrome chiuso."
                          aria-label="Apri su Google col robot"
                        >
                          <GoogleG />
                        </button>
                        <VediMail id={r.messaggioId} className="btn-mini" />
                      </div>
                    </form>
                  ) : (
                    <p className="notice dash-senza-regola">
                      Nessuna regola attiva copre questa recensione: accendi una regola da{" "}
                      <Link href="/impostazioni#automazioni">Impostazioni</Link>.
                    </p>
                  )}

                  {r.risolto && (
                    <footer className="dash-piede">
                      <span className="flag flag-gray">ticket risolto</span>
                    </footer>
                  )}
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

      {/* =========================================================== Storico === */}
      {step === "ricontrollo" && (
        <section className="dash-centro">
          {storico.length === 0 ? (
            <section className="card dash-vuoto">
              Nessuna risposta ancora pubblicata dal sito.
            </section>
          ) : (
            <ol className="pub-lista">
              {storico.map((v, i) => (
                <VoceStorico key={v.chiave} v={v} numero={i + 1} />
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
