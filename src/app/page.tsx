import Link from "next/link";
import { testoPerRecensione } from "@/server/automation/connectors";
import { caricaRegole, regolaPer } from "@/server/automation/rules";
import { caricaEsecuzioni } from "@/server/automation/runs";
import type { Azione, Regola } from "@/server/automation/types";
import { isGraphConfigured } from "@/server/graph/client";
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
import { operatoreCorrente } from "@/server/auth/sessione";
import {
  playAction,
  archiviaAction,
  ripristinaAction,
  mostraTutteAction,
} from "./dashboard/actions";
import { BottoneGoogle } from "./BottoneGoogle";
import { BottoneRispondi } from "./BottoneRispondi";
import {
  chiaviArchiviate,
  elencoArchiviate,
  type RecensioneArchiviata,
} from "@/server/db/recensioni";
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

/** Occhio aperto: sto mostrando tutte le recensioni. */
function IconaOcchio() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

/** Occhio barrato (default): mostro solo le recensioni con una regola attiva. */
function IconaOcchioBarrato() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}

type Passo = "approvare" | "pubblicare" | "ricontrollo" | "archiviati";

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
  }>;
}) {
  const sp = await searchParams;
  // Occhio in alto: spento (barrato) = solo le recensioni coperte da una regola
  // attiva (default); acceso = TUTTE le recensioni (1–5★), in ordine di stelle.
  //
  // Non è un filtro nell'indirizzo ma una preferenza del profilo: resta com'è
  // stata lasciata anche al prossimo accesso, e vale solo per chi la imposta.
  // Il layout ha già fatto il gate di sessione, qui l'operatore c'è sempre.
  const operatore = await operatoreCorrente();
  const tutte = operatore?.mostraTutte === true;
  const step: Passo =
    sp.step === "pubblicare"
      ? "pubblicare"
      : sp.step === "ricontrollo"
        ? "ricontrollo"
        : sp.step === "archiviati"
          ? "archiviati"
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
  let archiviate: RecensioneArchiviata[] = [];

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
    const [pubblicate, archiviateChiavi] = await Promise.all([
      chiaviPubblicate(),
      chiaviArchiviate(),
    ]);
    daApprovare = recensioni
      // Fuori dall'elenco:
      //  - ciò che abbiamo già pubblicato noi (stato pubblicata/verificata);
      //  - ciò a cui ha GIÀ RISPOSTO l'operatore a mano (haRisposta): gestita
      //    fuori dal nostro flusso, e non finisce nemmeno nello Storico;
      //  - ciò che è stato ARCHIVIATO a mano (es. impossibile da gestire): va
      //    nella tab «Archiviati», da dove si può ripristinare.
      //
      // NON si nasconde più per «ticket risolto»: un ticket chiuso su Freshdesk
      // NON vuol dire che abbiamo risposto alla recensione su Google (poteva
      // chiuderlo il customer care senza rispondere). Finché la recensione non è
      // pubblicata da noi, risposta nel thread, o archiviata, resta da lavorare.
      .filter(
        (r) => !pubblicate.has(r.chiave) && !r.haRisposta && !archiviateChiavi.has(r.chiave),
      )
      .map((r) => ({ r, regola: regolaPer(regole, r.stelle, haTesto(r)) }))
      // Occhio spento: solo le recensioni coperte da una regola ATTIVA (default).
      // Occhio acceso: TUTTE, anche quelle senza regola (regola === null).
      .filter((x) => tutte || x.regola !== null);

    // «Aggiorna» (tasto di pagina) rilegge soltanto la posta e riconta: NON
    // nasconde più le recensioni col ticket risolto/chiuso su Freshdesk. Un
    // ticket chiuso non equivale a una risposta pubblicata su Google, quindi
    // toglierle qui faceva sparire recensioni ancora da lavorare (es. Arthur).
    // Con l'occhio acceso: ordine per stelle crescente (1★ … 5★, senza voto in
    // fondo) e, a parità, dalla più recente. Spento resta l'ordine per data.
    if (tutte) {
      daApprovare.sort((a, b) => {
        const sa = a.r.stelle ?? 99;
        const sb = b.r.stelle ?? 99;
        if (sa !== sb) return sa - sb;
        return new Date(b.r.ricevutaIl).getTime() - new Date(a.r.ricevutaIl).getTime();
      });
    }
    nApprovare = daApprovare.length;

    runAperta = sp.run ? trovaRun(esecuzioni, sp.run) : undefined;
  }

  if (step === "archiviati") {
    archiviate = await elencoArchiviate();
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
          href="/?step=archiviati"
          className={`pub-tab${step === "archiviati" ? " is-active" : ""}`}
          title="Recensioni messe da parte (es. impossibili da gestire)"
        >
          Archiviati
        </Link>
        <Link
          href={
            step === "approvare"
              ? "/"
              : step === "ricontrollo"
                ? "/?step=ricontrollo"
                : step === "archiviati"
                  ? "/?step=archiviati"
                  : `/?step=pubblicare${sedeSel ? `&sede=${encodeURIComponent(sedeSel)}` : ""}`
          }
          className="pub-aggiorna"
          title={`Ultimo aggiornamento: ${aggiornatoAlle}`}
          aria-label="Aggiorna la vista"
        >
          <IconaAggiorna />
        </Link>
        {step === "approvare" && (
          <form action={mostraTutteAction} className="pub-occhio-form">
            <input type="hidden" name="valore" value={tutte ? "0" : "1"} />
            <button
              type="submit"
              className={`pub-occhio${tutte ? " is-active" : ""}`}
              title={
                tutte
                  ? "Mostro TUTTE le recensioni (1–5★). Clicca per vedere solo quelle con una regola attiva."
                  : "Mostro solo le recensioni con una regola attiva. Clicca per vedere tutte (1–5★)."
              }
              aria-pressed={tutte}
              aria-label={
                tutte
                  ? "Mostra solo le recensioni con una regola attiva"
                  : "Mostra tutte le recensioni (da 1 a 5 stelle)"
              }
            >
              {tutte ? <IconaOcchio /> : <IconaOcchioBarrato />}
            </button>
          </form>
        )}
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
              {tutte
                ? "Nessuna recensione da mostrare."
                : "Nessuna recensione da approvare (nessuna coperta dalle regole attive)."}
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
                  {/* Archiviazione: nessun campo, un solo tocco. Il form vive qui
                      (fuori dal form "Rispondi", che non si può annidare) e il
                      bottone «Archivia», messo tra le azioni classiche, lo invia
                      via attributo form=. */}
                  <form id={`arch-${r.chiave}`} action={archiviaAction} className="dash-arch-form">
                    <input type="hidden" name="chiave" value={r.chiave} />
                    <input type="hidden" name="label" value={label?.id ?? ""} />
                  </form>

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

                  {suggerito ? (
                    // Recensione coperta da una regola CON risposta (oggi solo
                    // «5★ senza commento»): box precompilato + flusso completo.
                    <form action={playAction} className="dash-proposta">
                      <input type="hidden" name="chiave" value={r.chiave} />
                      <input type="hidden" name="label" value={label?.id ?? ""} />
                      <input type="hidden" name="azioneId" value={nodo!.id} />
                      <input type="hidden" name="testoOriginale" value={suggerito.testo} />
                      <textarea
                        name="testo"
                        className="dash-testo"
                        rows={suggerito.testo.length > 120 ? 4 : 2}
                        defaultValue={suggerito.testo}
                        aria-label="Testo della risposta"
                      />
                      <div className="dash-azioni">
                        <BottoneRispondi />
                        <AnteprimaFlusso titolo={`Cosa farà su «${r.nome || "questa recensione"}»`}>
                          <ol className="ap-lista">
                            {regola!.azioni.map((a) => (
                              <PassoAnteprima key={a.id} azione={a} />
                            ))}
                          </ol>
                        </AnteprimaFlusso>
                        <BottoneGoogle chiave={r.chiave} label={label?.id ?? ""} nome={r.nome} />
                        <VediMail id={r.messaggioId} className="btn-mini" />
                        <BottoneArchivia chiave={r.chiave} />
                      </div>
                    </form>
                  ) : tutte ? (
                    // Con l'occhio acceso: recensione SENZA regola di risposta
                    // (o senza regola). Box VUOTO da compilare e SOLO azioni
                    // manuali: niente Rispondi, così non parte alcun flusso
                    // automatico (né una pubblicazione «Grazie.» su una negativa).
                    <form action={playAction} className="dash-proposta">
                      <input type="hidden" name="chiave" value={r.chiave} />
                      <input type="hidden" name="label" value={label?.id ?? ""} />
                      <textarea
                        name="testo"
                        className="dash-testo"
                        rows={2}
                        defaultValue=""
                        placeholder="Scrivi qui la risposta…"
                        aria-label="Testo della risposta"
                      />
                      <div className="dash-azioni">
                        <BottoneGoogle chiave={r.chiave} label={label?.id ?? ""} nome={r.nome} />
                        <VediMail id={r.messaggioId} className="btn-mini" />
                        <BottoneArchivia chiave={r.chiave} />
                      </div>
                    </form>
                  ) : (
                    <>
                      <p className="notice dash-senza-regola">
                        Nessuna regola di risposta copre questa recensione: accendi una regola da{" "}
                        <Link href="/impostazioni#automazioni">Impostazioni</Link>.
                      </p>
                      <div className="dash-azioni">
                        <VediMail id={r.messaggioId} className="btn-mini" />
                        <BottoneArchivia chiave={r.chiave} />
                      </div>
                    </>
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

      {/* =========================================================== Archiviati === */}
      {step === "archiviati" && (
        <section className="dash-centro">
          {archiviate.length === 0 ? (
            <section className="card dash-vuoto">
              Nessuna recensione archiviata. Dalla lista «Da approvare» puoi archiviare quelle che
              non è possibile gestire.
            </section>
          ) : (
            <ol className="pub-lista">
              {archiviate.map((r) => (
                <li key={r.chiave} className="card dash-card">
                  <div className="dash-autore-riga">
                    <span className="review-name">{r.nome || "senza nome"}</span>
                    <Stelle n={r.stelle} />
                  </div>
                  <div className="dash-meta">
                    {dataConGiorno(new Date(r.ricevutaIl))}
                    {r.sede ? ` · ${r.sede}` : ""}
                  </div>
                  {testoRecensione(r) && <p className="review-comment">{testoRecensione(r)}</p>}
                  {r.motivoArchiviazione && (
                    <p className="archivia-motivo-vista">🗄 {r.motivoArchiviazione}</p>
                  )}
                  <form action={ripristinaAction} className="archivia-ripristina">
                    <input type="hidden" name="chiave" value={r.chiave} />
                    <button type="submit" className="btn-mini">
                      Ripristina
                    </button>
                  </form>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
    </main>
  );
}

// --- helper ----------------------------------------------------------------

/**
 * Bottone «Archivia» da mettere in fila con le azioni classiche (Rispondi, G,
 * Vedi mail). Non ha un form suo: invia — con un solo tocco, senza motivo — il
 * form nascosto `arch-<chiave>` che sta sulla card, tramite l'attributo form=.
 */
function BottoneArchivia({ chiave }: { chiave: string }) {
  return (
    <button
      type="submit"
      form={`arch-${chiave}`}
      className="btn-mini btn-archivia"
      title="Mette da parte questa recensione: sparisce dall'elenco e va in Archiviati"
    >
      🗄 Archivia
    </button>
  );
}

type Esec = Awaited<ReturnType<typeof caricaEsecuzioni>>[number];

/** L'esecuzione appena conclusa da mostrare in cima (feedback dopo l'approvazione). */
function trovaRun(esecuzioni: Esec[], id: string): Esec | undefined {
  return esecuzioni.find((e) => e.id === id);
}
