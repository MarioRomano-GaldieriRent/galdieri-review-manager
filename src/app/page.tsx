import Link from "next/link";
import { Suspense } from "react";
import { after } from "next/server";
// La versione "con lingua già decisa": qui la lingua per le 5★ senza testo la
// stabilisce l'IA (linguaRispostaIA), pre-calcolata in blocco più sotto.
import { testoPerRecensioneConLingua } from "@/server/automation/connectors";
import { linguaRispostaIA } from "@/server/reviews/linguaNomeAI";
import { caricaRegole, conBeta, regolaPer } from "@/server/automation/rules";
import { caricaEsecuzione } from "@/server/automation/runs";
import type { Azione, Esecuzione, Regola } from "@/server/automation/types";
import { isGraphConfigured } from "@/server/graph/client";
import {
  elencoTicketRecenti,
  recensioniConTicket,
  recensioniConTicketRisolto,
  type EsitoSweep,
  type FdTicket,
} from "@/server/integrations/freshdesk";
import { caricaRecensioni, haTesto, testoRecensione, type Recensione } from "@/server/reviews/load";
import {
  chiaviPubblicate,
  codaDaPubblicare,
  storicoPubblicazioni,
  type VocePubblicazione,
} from "@/server/db/pubblicazioni";
import { ritentaChiusureInSospeso } from "@/server/pubblicazione";
import { elencoInAttesa, elencoPronte, type Escalation } from "@/server/db/escalation";
import { aggiornaAttese } from "@/server/reviews/rispostaCustomerCare";
import { isFreshdeskConfigured } from "@/server/integrations/freshdesk";
import { loadSettings, type Label } from "@/server/settings";
import { operatoreCorrente } from "@/server/auth/sessione";
import {
  playAction,
  archiviaAction,
  ripristinaAction,
  mostraTutteAction,
  avviaEscalationAction,
} from "./dashboard/actions";
import { BottoneRispondi } from "./BottoneRispondi";
import { BottoneTest } from "./BottoneTest";
import {
  chiaviArchiviate,
  elencoArchiviate,
  leggiRecensione,
  recensioniDaApprovare,
  type RecensioneArchiviata,
} from "@/server/db/recensioni";
import { VediMail } from "./VediMail";
import { BottoneSegnala } from "./BottoneSegnala";
import { inoltraAlCustomerCareAction } from "./dashboard/inoltro";
import { chiaviSegnalate } from "@/server/db/segnalazioni";
import { CampoRispostaAI } from "./CampoRispostaAI";
import { CampoRisposta } from "./CampoRisposta";
import { bozzePer, type Bozza } from "@/server/db/bozze";
import { suggerimentiPer } from "@/server/db/suggerimenti";
import { AutoAggiorna } from "./AutoAggiorna";
import { AnteprimaFlusso } from "./AnteprimaFlusso";
import { PassoAnteprima } from "./_ui/automazioni";
import { Stelle, VoceCoda, VoceStorico } from "./da-pubblicare/Voci";
import { TabRecensioni } from "./TabRecensioni";
import { TastieraCoda } from "./da-pubblicare/TastieraCoda";
import { FiltriDaApprovare } from "./FiltriDaApprovare";
import { ScheletroLista } from "./_ui/segnaposti";

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

type Passo = "approvare" | "attesa" | "pubblicare" | "ricontrollo" | "archiviati";

// Paginazione di «Da approvare»: si renderizzano le prime `n` card (parametro
// n nell'URL), non tutta la coda. I filtri girano comunque sull'INTERO insieme
// — la lista che si vede è sempre quella giusta, solo più corta — ma la pagina
// pesa e si costruisce in proporzione a quante card si mostrano, e le proposte
// AI si chiedono solo per quelle. Il conteggio nel tab resta il totale.
const PAGINA_DEFAULT = 25;
const PAGINE_SCELTE = [25, 50, 100] as const;
/** «Tutte» ha comunque un tetto: oltre non ha senso costruire una pagina sola. */
const PAGINA_MAX = 500;

function leggiPagina(n: string | undefined): number {
  if (n === "tutte") return PAGINA_MAX;
  const v = Number(n);
  return Number.isInteger(v) && v > 0 ? Math.min(v, PAGINA_MAX) : PAGINA_DEFAULT;
}

/**
 * Numero di pagina richiesto (parametro p): un intero ≥ 1, altrimenti 1. Il
 * tetto vero — l'ultima pagina che esiste — si applica dopo, quando si conosce
 * il totale delle recensioni.
 */
function leggiNumeroPagina(p: string | undefined): number {
  const v = Number(p);
  return Number.isInteger(v) && v > 0 ? v : 1;
}

/**
 * I numeri di pagina da mostrare nella barra: tutti se sono pochi, altrimenti
 * prima, ultima e una finestra intorno alla corrente, con «…» a segnare i
 * salti — una paginazione vera, non un elenco che si allunga da solo.
 */
function numeriPagina(corrente: number, totale: number): (number | "…")[] {
  if (totale <= 7) return Array.from({ length: totale }, (_, i) => i + 1);
  const scelte = new Set(
    [1, totale, corrente - 2, corrente - 1, corrente, corrente + 1, corrente + 2].filter(
      (n) => n >= 1 && n <= totale,
    ),
  );
  const ordinate = [...scelte].sort((a, b) => a - b);
  const righe: (number | "…")[] = [];
  let precedente = 0;
  for (const n of ordinate) {
    if (precedente && n - precedente > 1) righe.push("…");
    righe.push(n);
    precedente = n;
  }
  return righe;
}

/** Porta `n` e/o `p` nei link della vista (Aggiorna, cambio pagina/dimensione). */
function urlLista(extra: { fresh?: true; n?: number; p?: number } = {}): string {
  const q = new URLSearchParams();
  if (extra.fresh) q.set("fresh", "1");
  if (extra.n !== undefined && extra.n !== PAGINA_DEFAULT) {
    q.set("n", extra.n >= PAGINA_MAX ? "tutte" : String(extra.n));
  }
  if (extra.p !== undefined && extra.p > 1) q.set("p", String(extra.p));
  const s = q.toString();
  return s ? `/?${s}` : "/";
}

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
    /** Quante card per pagina in «Da approvare»: 25 (default), 50, 100, "tutte". */
    n?: string;
    /** Numero di pagina in «Da approvare» (1 in su). */
    p?: string;
  }>;
}) {
  const sp = await searchParams;
  const dimensionePagina = leggiPagina(sp.n);
  const numeroPaginaRichiesta = leggiNumeroPagina(sp.p);
  // Occhio in alto: spento (barrato) = solo le recensioni coperte da una regola
  // attiva (default); acceso = TUTTE le recensioni (1–5★), in ordine di stelle.
  //
  // Non è un filtro nell'indirizzo ma una preferenza del profilo: resta com'è
  // stata lasciata anche al prossimo accesso, e vale solo per chi la imposta.
  // Il layout ha già fatto il gate di sessione, qui l'operatore c'è sempre.
  const operatore = await operatoreCorrente();
  const tutte = operatore?.mostraTutte === true;
  // Regole in anteprima solo per questa persona (rollout graduale): restano
  // spente per tutti gli altri. Vedi conBeta().
  const regoleBeta = operatore?.regoleBeta ?? [];
  const step: Passo =
    sp.step === "pubblicare"
      ? "pubblicare"
      : sp.step === "ricontrollo"
        ? "ricontrollo"
        : sp.step === "archiviati"
          ? "archiviati"
          : sp.step === "attesa"
            ? "attesa"
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
  // Ritenta le chiusure Freshdesk rimaste in sospeso. È MANUTENZIONE: la
  // pagina non usa il risultato, ma finché stava qui davanti veniva ATTESA —
  // e ognuna è una scrittura verso Freshdesk, cioè secondi di attesa prima
  // ancora di cominciare a leggere i dati. Con `after()` parte quando la
  // risposta è già partita verso il browser: si fa lo stesso lavoro, ma non
  // davanti a chi guarda.
  after(async () => {
    try {
      const n = await ritentaChiusureInSospeso();
      if (n > 0) console.log(`[freshdesk] chiusure in sospeso ritentate: ${n}.`);
    } catch (e) {
      console.warn("[freshdesk] ritento chiusure saltato:", e instanceof Error ? e.message : e);
    }
  });
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
  let archiviate: RecensioneArchiviata[] = [];
  let inAttesa: Escalation[] = [];
  let nAttesa: number | null = null;

  // L'esecuzione appena conclusa da mostrare in cima (feedback dopo
  // l'approvazione): una findOne per id, solo se richiesta. Sta FUORI dal
  // lavoro pesante perché si mostra SOPRA i tab, cioè subito.
  const runAperta: Esecuzione | undefined = sp.run
    ? await caricaEsecuzione(sp.run)
    : undefined;

  // Il lavoro pesante di «Da approvare» comincia QUI ma NON si aspetta.
  //
  // La promessa la consumano due confini di attesa: il conteggio nel tab e la
  // lista. Così la pagina — intestazione, tab, banner — arriva al browser
  // subito, e le card si riempiono quando posta e Freshdesk hanno risposto:
  // prima si aspettavano quei 6 secondi con lo schermo fermo sulla vista
  // vecchia. Una promessa sola per due consumatori, quindi il lavoro si fa una
  // volta: passarla già avviata è ciò che lo garantisce.
  const datiApprovare =
    step === "approvare"
      ? caricaDatiApprovare({
          sp,
          label,
          tutte,
          regoleBeta,
          dimensionePagina,
          numeroPaginaRichiesta,
          fdOk,
        })
      : null;

  // Identifica la vista: è la chiave del confine di attesa. Senza, cambiando
  // pagina o filtro React terrebbe a schermo la lista vecchia invece di
  // mostrare che sta caricando.
  const chiaveVista = `${sp.p ?? "1"}-${sp.n ?? ""}-${tutte ? "tutte" : "regole"}`;


  if (step === "archiviati") {
    archiviate = await elencoArchiviate();
  }

  if (step === "attesa") {
    // Cerca prima le risposte arrivate (attesa → pronta), poi elenca ciò che
    // resta in attesa. Best-effort sul recupero.
    try {
      await aggiornaAttese();
    } catch (e) {
      console.warn("[attese] recupero risposte saltato:", e instanceof Error ? e.message : e);
    }
    inAttesa = await elencoInAttesa();
    nAttesa = inAttesa.length;
  }


  return (
    <main className="pipeline">
      {sp.errore && (
        <section className="card">
          <p className="form-error">
            {sp.errore === "nessuna-regola"
              ? "Nessuna regola attiva copre questa recensione: puoi solo inoltrarla al customer care."
              : sp.errore === "segnalazione-senza-nota"
                ? "Per segnalare una recensione all'amministratore devi scrivere qual è il problema."
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
        <TabRecensioni
          voci={[
            {
              href: "/",
              etichetta: "Da approvare",
              titolo: "Recensioni coperte dalle regole attive, in attesa di una tua decisione",
              attivo: step === "approvare",
              // Il conteggio esce dallo STESSO lavoro della lista: ha un suo
              // confine di attesa, così i tab si vedono subito e il numero
              // arriva quando c'è. `fallback={null}`: meglio niente che un
              // numero sbagliato.
              conteggio: datiApprovare ? (
                <Suspense fallback={null}>
                  <ContoApprovare dati={datiApprovare} />
                </Suspense>
              ) : null,
            },
            {
              href: "/?step=attesa",
              etichetta: "In attesa",
              titolo: "Recensioni negative inoltrate al customer care, in attesa della risposta",
              attivo: step === "attesa",
              conteggio: datiApprovare ? (
                <Suspense fallback={null}>
                  <ContoAttesa dati={datiApprovare} />
                </Suspense>
              ) : (
                <Pallino n={nAttesa} />
              ),
            },
            {
              href: "/?step=ricontrollo",
              etichetta: "Storico",
              titolo: "Cronologia delle risposte pubblicate dal nostro sito",
              attivo: step === "ricontrollo",
              conteggio: null,
            },
            {
              href: "/?step=archiviati",
              etichetta: "Archiviati",
              titolo: "Recensioni messe da parte (es. impossibili da gestire)",
              attivo: step === "archiviati",
              conteggio: null,
            },
          ]}
        />
        <Link
          href={
            step === "approvare"
              ? urlLista({ fresh: true, n: dimensionePagina, p: numeroPaginaRichiesta })
              : step === "attesa"
                ? "/?step=attesa"
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
      {datiApprovare && (
        <Suspense key={chiaveVista} fallback={<ScheletroLista />}>
          <SezioneApprovare
            dati={datiApprovare}
            label={label}
            tutte={tutte}
            dimensionePagina={dimensionePagina}
            operatore={operatore}
          />
        </Suspense>
      )}

      {/* ===================================================== In attesa === */}
      {step === "attesa" && (
        <section className="dash-centro">
          <AutoAggiorna />
          {inAttesa.length === 0 ? (
            <section className="card dash-vuoto">
              Nessuna recensione in attesa. Le negative inoltrate al customer care restano qui
              finché non arriva la risposta, poi tornano da sole in «Da approvare» precompilate.
            </section>
          ) : (
            inAttesa.map((e) => (
              <article key={e.chiave} className="card dash-card">
                <header className="dash-card-testa">
                  <div className="dash-autore">
                    <span className="dash-iniziale" aria-hidden="true">
                      {(e.nomeCliente || "?").trim().charAt(0).toUpperCase()}
                    </span>
                    <div>
                      <div className="dash-autore-riga">
                        <span className="review-name">{e.nomeCliente || "senza nome"}</span>
                      </div>
                      <div className="dash-meta">
                        {dataConGiorno(new Date(e.ricevutaIl))} ·{" "}
                        {oraFmt.format(new Date(e.ricevutaIl))}
                        {e.sedeNome ? ` · ${e.sedeNome}` : ""}
                      </div>
                    </div>
                  </div>
                  <div className="dash-scheda">
                    <Stelle n={e.stelle} />
                  </div>
                </header>

                {e.originale && <p className="review-comment">{e.originale}</p>}

                <p className="notice">
                  ⏳ Inoltrata al customer care il {dataConGiorno(new Date(e.inoltrataIl))} · in
                  attesa della risposta.
                  {e.ticketId ? (
                    <>
                      {" · ticket "}
                      <Link href={`/ticket/${e.ticketId}`}>#{e.ticketId}</Link>
                    </>
                  ) : null}
                </p>
                <div className="dash-azioni">
                  <VediMail id={e.messaggioId} className="btn-mini" />
                </div>
              </article>
            ))
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
                    {dataConGiorno(new Date(r.ricevutaIl))} ·{" "}
                    {oraFmt.format(new Date(r.ricevutaIl))}
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

/** L'archivio: la classica scatola con coperchio e fessura. */
function IconaArchivio() {
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
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" />
      <line x1="10" y1="13" x2="14" y2="13" />
    </svg>
  );
}

/**
 * Bottone «Archivia» in fila con le azioni classiche (Vedi mail, Anteprima):
 * stessa forma tonda a icona, sola. Non ha un form suo: invia — con un solo
 * tocco, senza motivo — il form nascosto `arch-<chiave>` che sta sulla card,
 * tramite l'attributo form=.
 */
function BottoneArchivia({ chiave }: { chiave: string }) {
  return (
    <button
      type="submit"
      form={`arch-${chiave}`}
      className="btn-occhio"
      title="Mette da parte questa recensione: sparisce dall'elenco e va in Archiviati"
      aria-label="Archivia"
    >
      <IconaArchivio />
    </button>
  );
}


// ============================================================ Da approvare ===
// Il pezzo lento della home: la lettura dei dati e la vista che li mostra.
// Stanno qui sotto, nello stesso file della pagina, per continuare a usare gli
// aiutanti definiti sopra — urlLista, numeriPagina, nodoRisposta, i
// formattatori — senza doverli esportare in giro solo per spostare del codice.

/** Una voce della lista: la recensione e come va trattata. */
type VoceApprovare = {
  r: Recensione;
  regola: Regola | null;
  rispostaPronta?: string | null;
  /** Se la risposta è tornata «pronta» dal customer care: quando è tornata,
   * da usare SOLO per ordinare la lista — non tocca né sostituisce la data
   * di ricezione vera (r.ricevutaIl), che resta intatta. */
  dataOrdinamento?: string;
};

/** Il risultato del lavoro pesante, consumato dal conteggio e dalla lista. */
type DatiApprovare = {
  daApprovare: VoceApprovare[];
  visibili: VoceApprovare[];
  numeroPagina: number;
  totalePagine: number;
  nApprovare: number | null;
  nAttesa: number | null;
  suggeritiAI: Map<string, { testo: string }>;
  bozze: Map<string, Bozza>;
  linguaPerNome: Map<string, "it" | "altra">;
  graphOk: boolean;
  erroreGraph: string | null;
  nonVerificate: number;
  erroreFreshdesk: string | null;
};

/**
 * Tutto il lavoro di «Da approvare»: posta, regole, escalation, sweep
 * Freshdesk, paginazione, proposte AI. È la parte lenta della home — misurati
 * ~3,5 s per la posta e ~2,5 s per Freshdesk a cache fredda — ed è per questo
 * che sta dietro un confine di attesa invece che davanti alla pagina.
 *
 * Si chiama UNA volta e la promessa si passa a chi la deve leggere: chiamarla
 * due volte (una per il conteggio, una per la lista) rifarebbe tutto due volte.
 */
async function caricaDatiApprovare({
  sp,
  label,
  tutte,
  regoleBeta,
  dimensionePagina,
  numeroPaginaRichiesta,
  fdOk,
}: {
  sp: { fresh?: string };
  label: Label | null;
  tutte: boolean;
  regoleBeta: string[];
  dimensionePagina: number;
  numeroPaginaRichiesta: number;
  fdOk: boolean;
}): Promise<DatiApprovare> {
  let graphOk = true;
  let erroreGraph: string | null = null;
  let daApprovare: VoceApprovare[] = [];
  /** Le sole card della pagina corrente: quelle che si renderizzano davvero. */
  let visibili: VoceApprovare[] = [];
  let numeroPagina = 1;
  let totalePagine = 1;
  let nApprovare: number | null = null;
  /** Proposte AI già salvate, per chiave recensione (le mancanti se le chiede la card). */
  let suggeritiAI = new Map<string, { testo: string }>();
  /** Testi riscritti a mano e non ancora pubblicati: vincono su tutto il resto. */
  let bozze = new Map<string, Bozza>();
  /** Lingua decisa dall'IA per le 5★ senza testo (nessun altro segnale da cui riconoscerla). */
  let linguaPerNome = new Map<string, "it" | "altra">();
  let nAttesa: number | null = null;
  /** Recensioni che Freshdesk non ha fatto in tempo a verificare (restano in lista). */
  let nonVerificate = 0;
  let erroreFreshdesk: string | null = null;


  graphOk = await isGraphConfigured();
  const forza = sp.fresh === "1"; // «Aggiorna»: posta e ticket riletti davvero

  // Tutto ciò che non dipende dalla posta parte INSIEME e si sovrappone
  // all'ingest Graph, il pezzo lento: regole, chiavi già pubblicate/archiviate
  // e l'eventuale esecuzione da mostrare sono letture Mongo da ~25 ms l'una,
  // che prima stavano in fila una dietro l'altra. Le promise nascono qui e si
  // consumano subito nel Promise.all (o hanno già il loro catch): un errore
  // non resta mai senza gestore. La lista delle recensioni si legge DOPO
  // l'ingest, perché è lui a portare in archivio i nuovi arrivi.
  //
  // INGEST leggero: da Graph si scarica solo una finestra piccola (le ~100
  // email più recenti), giusto per portare nell'archivio i NUOVI arrivi — non
  // più 200 email a ogni caricamento. La cache breve (90 s) resta: solo
  // «Aggiorna» (fresh=1) rifa l'ingest davvero; l'auto-refresh la cavalca.
  const pIngest: Promise<string | null> =
    graphOk && label
      ? caricaRecensioni(label, { top: 100, forza }).then(
          () => null,
          (e) => (e instanceof Error ? e.message : "Errore sconosciuto"),
        )
      : Promise.resolve(null);
  // ESCALATION «In attesa»: cerca le risposte del customer care arrivate (le
  // voci passano da «attesa» a «pronta»). Parla con Graph, quindi va in
  // parallelo all'ingest; si attende più sotto, prima di leggere attese e
  // pronte. Best-effort.
  const pAttese: Promise<void> = graphOk
    ? aggiornaAttese().then(
        () => undefined,
        (e) =>
          console.warn("[attese] recupero risposte saltato:", e instanceof Error ? e.message : e),
      )
    : Promise.resolve();

  const [regoleBase, pubblicate, archiviateChiavi, segnalateChiavi, erroreIngest] = await Promise.all([
    caricaRegole(),
    chiaviPubblicate(),
    chiaviArchiviate(),
    chiaviSegnalate(),
    pIngest,
  ]);
  // Per questa persona le sue regole in anteprima contano come attive.
  const regole = conBeta(regoleBase, regoleBeta);
  erroreGraph = erroreIngest;

  // La LISTA viene dall'ARCHIVIO Mongo (query indicizzata, veloce), non dalla
  // finestra della posta: ha TUTTO l'arretrato recente e non perde ciò che è
  // scivolato oltre la finestra (era il caso di Arthur). Funziona anche se
  // Graph è momentaneamente giù.
  const recensioni: Recensione[] = await recensioniDaApprovare();

  // Lista UNICA: le recensioni ancora da pubblicare su Google. Sparisce solo
  // ciò che è già stato pubblicato (stato pubblicata/verificata); quelle
  // "approvata" ma non ancora pubblicate (robot non riuscito) restano qui per
  // riprovare col Play. Guidata dalle regole ATTIVE: oggi solo "5★ senza
  // commento", accendendone altre in Impostazioni compaiono anche le loro.
  daApprovare = recensioni
    // Fuori dall'elenco:
    //  - ciò che abbiamo già pubblicato noi (stato pubblicata/verificata);
    //  - ciò a cui ha GIÀ RISPOSTO l'operatore a mano (haRisposta): gestita
    //    fuori dal nostro flusso, e non finisce nemmeno nello Storico;
    //  - ciò che è stato ARCHIVIATO a mano (es. impossibile da gestire): va
    //    nella tab «Archiviati», da dove si può ripristinare;
    //  - ciò che è stato SEGNALATO all'amministratore (tasto «?»): è in carico
    //    a lui in Supervisione finché non lo rimette in coda.
    //
    // NB: qui NON si guarda l'email «ticket risolto» (segnale debole). Lo stato
    // VERO del ticket su Freshdesk lo si controlla più sotto, con una sweep.
    .filter(
      (r) =>
        !pubblicate.has(r.chiave) &&
        !r.haRisposta &&
        !archiviateChiavi.has(r.chiave) &&
        !segnalateChiavi.has(r.chiave),
    )
    .map((r) => ({ r, regola: regolaPer(regole, r.stelle, haTesto(r)) }))
    // Occhio spento: solo le recensioni coperte da una regola ATTIVA (default).
    // Occhio acceso: TUTTE, anche quelle senza regola (regola === null).
    .filter((x) => tutte || x.regola !== null);

  // ESCALATION «In attesa»: finito il recupero delle risposte (avviato sopra,
  // in parallelo), si separa. Le ATTESE (inoltrate, nessuna risposta) ESCONO
  // dalla lista → vanno nel tab «In attesa». Le PRONTE (risposta arrivata)
  // RESTANO, precompilate col testo, e SALTANO i filtri Freshdesk (devono
  // comparire per essere pubblicate). Tutto best-effort.
  let prontaMap = new Map<string, { testo: string | null; aggiornataIl: string }>();
  await pAttese;
  try {
    const [attese, pronte] = await Promise.all([elencoInAttesa(), elencoPronte()]);
    nAttesa = attese.length;
    const attesaSet = new Set(attese.map((e) => e.chiave));
    prontaMap = new Map(
      pronte.map((p) => [
        p.chiave,
        { testo: p.rispostaTesto, aggiornataIl: p.rispostaTrovataIl ?? p.aggiornataIl },
      ]),
    );
    daApprovare = daApprovare.filter((x) => !attesaSet.has(x.r.chiave));

    // Una PRONTA non deve mai cadere fuori per anzianità né per i filtri della
    // coda: la risposta di Cherubina è arrivata ADESSO, anche se la recensione
    // è di un mese fa, e finché non è pubblicata su Google il lavoro non è
    // finito. `recensioniDaApprovare` guarda solo gli ultimi 30 giorni e scarta
    // chi ha `haRisposta` — e l'inoltro a mano di Stefania conta come
    // «haRisposta», quindi proprio le più vecchie sparivano portandosi via il
    // testo del customer care. Qui si rimettono, saltando quei due criteri ma
    // non gli altri: pubblicata, archiviata o segnalata resta fuori.
    const mancanti = pronte.filter((p) => !daApprovare.some((x) => x.r.chiave === p.chiave));
    if (mancanti.length > 0) {
      const ripescate = (await Promise.all(mancanti.map((p) => leggiRecensione(p.chiave))))
        .filter((r): r is RecensioneArchiviata => r !== null)
        .filter(
          (r) =>
            !pubblicate.has(r.chiave) &&
            !archiviateChiavi.has(r.chiave) &&
            !segnalateChiavi.has(r.chiave),
        )
        .map((r) => ({ r, regola: regolaPer(regole, r.stelle, haTesto(r)) }));
      if (ripescate.length > 0) {
        daApprovare = [...daApprovare, ...ripescate];
        console.log(
          `[da-approvare] risposte del customer care ripescate fuori finestra: ${ripescate.length}.`,
        );
      }
    }
  } catch (e) {
    console.warn("[attese] lettura saltata:", e instanceof Error ? e.message : e);
  }

  // Le NEGATIVE il cui thread di posta contiene già «Ticket Risolto» sono state
  // gestite dal customer care: via subito, dal solo segnale dell'archivio, SENZA
  // interrogare Freshdesk. Cattura anche i casi che la sweep NON aggancia —
  // recensione vecchia / inoltro tardivo, es. Paula López (ticket fuori finestra).
  const conInoltro = (x: (typeof daApprovare)[number]) =>
    Boolean(x.regola?.azioni.some((a) => a.tipo === "email.inoltra"));
  {
    const prima = daApprovare.length;
    // Le PRONTE non si toccano (devono comparire precompilate).
    daApprovare = daApprovare.filter(
      (x) => prontaMap.has(x.r.chiave) || !(conInoltro(x) && x.r.risolto),
    );
    if (prima !== daApprovare.length)
      console.log(
        `[da-approvare] negative già risolte (thread «ticket risolto»): nascoste ${prima - daApprovare.length}.`,
      );
  }

  // Freshdesk toglie dalla lista ciò che è già gestito, con DUE criteri diversi
  // (UNA sola sweep condivisa dei ticket, niente fan-out N×):
  //  - «resto» (positive/scoperte): sparisce se il suo ticket è RISOLTO/CHIUSO
  //    (gestita da fuori). Match del ticket SPECIFICO per nome, così nasconde
  //    anche in sedi attive con altri ticket aperti (es. Bari).
  //  - «negative» (regola con inoltro): sparisce se un ticket ESISTE già, a
  //    QUALSIASI stato e a QUALSIASI ora — «ha un ticket» = «già inoltrata». Il
  //    tempo non conta: la mail può essere un inoltro tardivo. Quelle SENZA
  //    ticket (e non ancora risolte) restano, da inoltrare.
  // Best-effort: se Freshdesk non risponde, non si nasconde nulla e lo si
  // dice (banner). Oggi le sweep non chiamano Freshdesk (i corpi sono già
  // nella lista): un 429 può arrivare solo dall'elenco, ed è tutto o niente.
  // Se una sweep dovesse fermarsi a metà (ripiego getTicket), ciò che ha già
  // CONFERMATO resta nascosto: si nasconde solo il provato, mai al contrario.
  if (fdOk && daApprovare.length > 0) {
    const perFd = (x: (typeof daApprovare)[number]) => ({
      chiave: x.r.chiave,
      oggetto: x.r.oggetto,
      ricevutaIl: x.r.ricevutaIl,
      nome: x.r.nome,
    });
    // Le PRONTE (con risposta) saltano la sweep: devono restare in lista.
    const negativi = daApprovare
      .filter((x) => conInoltro(x) && !prontaMap.has(x.r.chiave))
      .map(perFd);
    const resto = daApprovare.filter((x) => !conInoltro(x)).map(perFd);
    // Lista ticket (col corpo) scaricata UNA volta e CONDIVISA fra le due
    // sweep: con forza la cache non le farebbe riusare (sarebbero 12 GET
    // invece di 6). Senza lista non si verifica nulla: tutte restano in vista.
    let tickets: FdTicket[] | null = null;
    try {
      tickets = await elencoTicketRecenti(6, forza);
    } catch (e) {
      // Freshdesk non raggiungibile o a rate-limit (429): NON è un errore
      // bloccante — le negative già RISOLTE sono comunque nascoste (dal segnale
      // d'archivio, sopra). console.warn (non error) per non far scattare
      // l'overlay.
      erroreFreshdesk = e instanceof Error ? e.message : String(e);
      nonVerificate = resto.length + negativi.length;
      console.warn("[da-approvare] elenco ticket Freshdesk non disponibile:", erroreFreshdesk);
    }
    if (tickets) {
      // Le sweep non sollevano: ognuna riporta le CONFERMATE e quante non è
      // riuscita a verificare. Si applicano entrambe, anche se una è parziale.
      const nascoste = new Set<string>();
      const applica = (e: EsitoSweep) => {
        for (const c of e.nascoste) nascoste.add(c);
        nonVerificate += e.nonVerificate;
        if (e.errore) erroreFreshdesk = e.errore;
      };
      if (resto.length > 0) applica(await recensioniConTicketRisolto(resto, { forza, tickets }));
      if (negativi.length > 0) applica(await recensioniConTicket(negativi, { forza, tickets }));
      const prima = daApprovare.length;
      daApprovare = daApprovare.filter((x) => !nascoste.has(x.r.chiave));
      console.log(
        `[da-approvare] filtro Freshdesk: nascoste ${prima - daApprovare.length} su ${prima} (risolte o già inoltrate)${
          nonVerificate > 0 ? `, non verificate ${nonVerificate} (${erroreFreshdesk})` : ""
        }.`,
      );
    }
  } else {
    console.log(
      `[da-approvare] filtro Freshdesk saltato (Freshdesk configurato: ${fdOk}, in coda: ${daApprovare.length}).`,
    );
  }

  // Precompila le PRONTE col testo recuperato dal customer care: nella card
  // comparirà il box già pieno, pronto da pubblicare su Google. Porta anche
  // la data in cui la risposta è arrivata: serve solo per l'ordinamento qui
  // sotto, non tocca r.ricevutaIl (che resta la data vera di arrivo).
  if (prontaMap.size > 0) {
    daApprovare = daApprovare.map((x) => {
      const p = prontaMap.get(x.r.chiave);
      return p ? { ...x, rispostaPronta: p.testo, dataOrdinamento: p.aggiornataIl } : x;
    });
  }

  // La data su cui ordinare: per una recensione tornata «pronta» dal
  // customer care conta QUANDO è tornata, non quando è arrivata in origine
  // — altrimenti resterebbe sepolta fra recensioni più vecchie di lei, pur
  // essendo di nuovo da lavorare oggi. Nessun dato si perde: è solo la
  // CHIAVE DI ORDINAMENTO a cambiare, non r.ricevutaIl né altro sulla scheda.
  const dataOrdine = (x: (typeof daApprovare)[number]) =>
    new Date(x.dataOrdinamento ?? x.r.ricevutaIl).getTime();

  // Con l'occhio acceso: ordine per stelle crescente (1★ … 5★, senza voto in
  // fondo) e, a parità, per data di ordinamento (dalla più recente). Spento:
  // stesso criterio ma senza raggruppare per stelle — la query Mongo arriva
  // già ordinata per ricevutaIl, ma da sola non basta più: una «pronta» deve
  // scavalcare recensioni ricevute dopo di lei ma rimaste ferme.
  if (tutte) {
    daApprovare.sort((a, b) => {
      const sa = a.r.stelle ?? 99;
      const sb = b.r.stelle ?? 99;
      if (sa !== sb) return sa - sb;
      return dataOrdine(b) - dataOrdine(a);
    });
  } else {
    daApprovare.sort((a, b) => dataOrdine(b) - dataOrdine(a));
  }
  nApprovare = daApprovare.length;
  // DOPO tutti i filtri e l'ordinamento: si divide in pagine solo ciò che
  // resta. Un numero di pagina fuori range (link vecchio, dati cambiati nel
  // frattempo) ripiega sull'ultima pagina che esiste, mai su una vuota.
  totalePagine = Math.max(1, Math.ceil(daApprovare.length / dimensionePagina));
  numeroPagina = Math.min(Math.max(1, numeroPaginaRichiesta), totalePagine);
  visibili = daApprovare.slice(
    (numeroPagina - 1) * dimensionePagina,
    numeroPagina * dimensionePagina,
  );

  // Proposte AI GIÀ generate per le positive con commento fra quelle MOSTRATE:
  // una sola query, e la card parte col box pieno. Quelle che mancano se le
  // chiede il campo da solo, a pagina già visibile (vedi CampoRispostaAI).
  const chiaviAI = visibili
    .filter((x) => (x.r.stelle ?? 0) >= 4 && (x.r.originale || "").trim() && !x.rispostaPronta)
    .map((x) => x.r.chiave);
  if (chiaviAI.length > 0) {
    try {
      suggeritiAI = await suggerimentiPer(chiaviAI);
    } catch (e) {
      console.warn("[ai] lettura suggerimenti non riuscita:", e);
    }
  }

  // Le bozze delle card MOSTRATE: una query sola. Best-effort come le
  // proposte — se non si leggono, il riquadro riparte dalla proposta.
  try {
    bozze = await bozzePer(visibili.map((x) => x.r.chiave));
  } catch (e) {
    console.warn("[bozze] lettura non riuscita:", e);
  }

  // Le 5★ SENZA testo non hanno nessun segnale da cui riconoscere la lingua:
  // chi decide "Grazie." o "Thank you." è il NOME, chiesto all'IA (con
  // cache: uno stesso nome non ripaga mai la domanda due volte) invece che
  // da una lista scritta a mano — vedi reviews/linguaNomeAI.ts. Calcolato UNA
  // volta qui, non dentro il map() di rendering più sotto, così una pagina
  // con più card fa al massimo N domande nuove, non una per ogni render.
  const senzaTesto = visibili.filter((x) => !x.rispostaPronta && !haTesto(x.r));
  if (senzaTesto.length > 0) {
    try {
      const risultati = await Promise.all(
        senzaTesto.map(
          async (x) =>
            [x.r.chiave, await linguaRispostaIA(x.r.lingua, x.r.originale, x.r.nome)] as const,
        ),
      );
      linguaPerNome = new Map(risultati);
    } catch (e) {
      console.warn("[lingua] riconoscimento IA del nome non riuscito:", e);
    }
  }

  return {
    daApprovare,
    visibili,
    numeroPagina,
    totalePagine,
    nApprovare,
    nAttesa,
    suggeritiAI,
    bozze,
    linguaPerNome,
    graphOk,
    erroreGraph,
    nonVerificate,
    erroreFreshdesk,
  };
}

/** Il pallino col numero accanto al nome del tab. Zero e assente non si mostrano. */
function Pallino({ n }: { n: number | null }) {
  return n !== null && n > 0 ? <span className="chip-count">{n}</span> : null;
}

/** Il conteggio di «Da approvare»: esce dallo stesso lavoro della lista. */
async function ContoApprovare({ dati }: { dati: Promise<DatiApprovare> }) {
  return <Pallino n={(await dati).nApprovare} />;
}

/** Il conteggio di «In attesa» quando si sta guardando «Da approvare». */
async function ContoAttesa({ dati }: { dati: Promise<DatiApprovare> }) {
  return <Pallino n={(await dati).nAttesa} />;
}

/**
 * La lista «Da approvare». Aspetta il lavoro pesante: finché non è pronto, al
 * suo posto si vedono gli scheletri — il resto della pagina è già a schermo.
 */
async function SezioneApprovare({
  dati,
  label,
  tutte,
  dimensionePagina,
  operatore,
}: {
  dati: Promise<DatiApprovare>;
  label: Label | null;
  tutte: boolean;
  dimensionePagina: number;
  operatore: Awaited<ReturnType<typeof operatoreCorrente>>;
}) {
  const {
    daApprovare,
    visibili,
    numeroPagina,
    totalePagine,
    suggeritiAI,
    bozze,
    linguaPerNome,
    graphOk,
    erroreGraph,
    nonVerificate,
    erroreFreshdesk,
  } = await dati;

  // Per chi legge: niente codici HTTP. Il messaggio grezzo resta nei log.
  const motivoFreshdesk = !erroreFreshdesk
    ? ""
    : /429/.test(erroreFreshdesk)
      ? " (troppe richieste in questo minuto)"
      : " (non risponde)";

  return (

    <section
      className="dash-centro"
      // Quante card ci sono davvero nella pagina rispetto al totale: chi
      // cerca o filtra fra le card nel browser sa che vede solo le prime.
      data-mostrate={visibili.length}
      data-totale={daApprovare.length}
    >
      <AutoAggiorna />

      {!graphOk && (
        <section className="card">
          <p className="form-error">
            Microsoft Graph non è configurato: la lista qui sotto viene dall&apos;archivio, ma
            senza posta non arrivano nuove recensioni.
          </p>
        </section>
      )}
      {erroreGraph && (
        <section className="card">
          <p className="form-error">Errore nella lettura della posta: {erroreGraph}</p>
        </section>
      )}
      {nonVerificate > 0 && (
        <section className="card">
          <p className="notice">
            ⚠{" "}
            {nonVerificate === 1
              ? "1 recensione non verificata"
              : `${nonVerificate} recensioni non verificate`}{" "}
            su Freshdesk{motivoFreshdesk}: se qualcuna è già stata gestita, per ora resta in
            lista. Fra un minuto premi «Aggiorna».
          </p>
        </section>
      )}

      {/* Ricerca e filtro stelle: lavorano nel browser sulle card qui sotto,
          senza ricaricare la pagina — un ricarico rifarebbe l'ingest della
          posta e le sweep Freshdesk a ogni tasto premuto. */}
      {daApprovare.length > 0 && <FiltriDaApprovare />}

      {daApprovare.length === 0 ? (
        <section className="card dash-vuoto">
          {tutte
            ? "Nessuna recensione da mostrare."
            : "Nessuna recensione da approvare (nessuna coperta dalle regole attive)."}
        </section>
      ) : (
        visibili.map(({ r, regola, rispostaPronta }) => {
          const nodo = regola ? nodoRisposta(regola) : null;
          const proposta = nodo
            ? testoPerRecensioneConLingua(nodo, r, linguaPerNome.get(r.chiave) ?? null)
            : null;
          // Se il customer care ha già rimandato la risposta (voce «pronta»),
          // il box è PRECOMPILATO con quel testo. Altrimenti: risposta "pronta"
          // solo se il nodo propone davvero un testo — le 1-2★ hanno un
          // google.rispondi VUOTO finché non arriva la risposta, così non
          // compare il box né parte un «Grazie.» su una negativa.
          const suggerito = rispostaPronta
            ? { testo: rispostaPronta, lingua: proposta?.lingua ?? ("it" as const) }
            : proposta && proposta.testo.trim()
              ? proposta
              : null;
          const testo = testoRecensione(r);
          const mostraOriginale = Boolean(
            r.originale && !r.giaItaliano && r.originale !== testo,
          );
          // La proposta la scrive l'AI sulle recensioni CON commento dalle 3★
          // in su: le 5★ senza testo hanno «Grazie.» di default, le 1-2★
          // passano dal customer care (e lì il box porta la risposta di
          // Cherubina). Le 3★ sono l'ibrido: proposta AI E tasto d'inoltro.
          const conAI =
            Boolean(suggerito) &&
            !rispostaPronta &&
            (r.stelle ?? 0) >= 3 &&
            Boolean((r.originale || "").trim());
          // Sotto la soglia delle positive (stesso confine di «positiva» in
          // playAction) la card col box offre ANCHE l'inoltro al customer
          // care: oggi sono le 3★ — le 1-2★ arrivano qui col box solo
          // «pronte», quando l'inoltro è già stato fatto.
          const offriInoltro = Boolean(suggerito) && !rispostaPronta && (r.stelle ?? 0) < 4;
          const suggerimentoAI = conAI ? suggeritiAI.get(r.chiave) : undefined;
          // La bozza scritta a mano è l'ultima parola: vince sulla proposta
          // della regola e su quella dell'AI, perché è lavoro di una persona.
          const bozza = bozze.get(r.chiave)?.testo ?? null;

          return (
            <article
              key={r.chiave}
              className="card dash-card"
              // Su cosa filtra la barra di ricerca (FiltriDaApprovare). Il
              // testo porta anche l'originale in lingua, così si trova sia
              // cercando la parola tradotta sia quella scritta dal cliente.
              data-nome={r.nome}
              data-sede={r.sede}
              data-stelle={r.stelle ?? ""}
              data-testo={[testo, r.originale].filter(Boolean).join(" ")}
            >
              {/* Archiviazione: nessun campo, un solo tocco. Il form vive qui
                  (fuori dal form "Rispondi", che non si può annidare) e il
                  bottone «Archivia», messo tra le azioni classiche, lo invia
                  via attributo form=. */}
              <form id={`arch-${r.chiave}`} action={archiviaAction} className="dash-arch-form">
                <input type="hidden" name="chiave" value={r.chiave} />
                <input type="hidden" name="label" value={label?.id ?? ""} />
              </form>
              {/* Inoltro al customer care dalle card ibride (3★): il tasto sta
                  fra le azioni, dentro il form «Rispondi», e invia QUESTO via
                  attributo form= — non la regola della recensione. */}
              {offriInoltro && (
                <form
                  id={`inol-${r.chiave}`}
                  action={inoltraAlCustomerCareAction}
                  className="dash-arch-form"
                >
                  <input type="hidden" name="chiave" value={r.chiave} />
                </form>
              )}

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
                      {dataConGiorno(new Date(r.ricevutaIl))} ·{" "}
                      {oraFmt.format(new Date(r.ricevutaIl))}
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
                // Box precompilato + flusso completo. Per le negative è la
                // RISPOSTA del customer care (voce «pronta»); per le 5★ senza
                // commento è il ringraziamento della regola.
                <form action={playAction} className="dash-proposta">
                  {rispostaPronta && (
                    <p className="notice flag-green-box">
                      ✓ Risposta rimandata dal customer care — controlla e pubblicala su Google.
                    </p>
                  )}
                  <input type="hidden" name="chiave" value={r.chiave} />
                  <input type="hidden" name="label" value={label?.id ?? ""} />
                  <input type="hidden" name="azioneId" value={nodo!.id} />
                  {conAI ? (
                    // CON commento (3-5★): la proposta la scrive l'AI sugli
                    // esempi veri di Stefania (pannello Memoria). Il campo si
                    // carica da solo a pagina già visibile; il testoOriginale
                    // che porta è quello della regola (vedi CampoRispostaAI).
                    <CampoRispostaAI
                      chiave={r.chiave}
                      iniziale={suggerimentoAI?.testo ?? null}
                      ripiego={suggerito.testo}
                      bozza={bozza}
                    />
                  ) : (
                    <CampoRisposta
                      chiave={r.chiave}
                      iniziale={bozza ?? suggerito.testo}
                      proposta={suggerito.testo}
                    />
                  )}
                  <div className="dash-azioni">
                    <BottoneRispondi />
                    {operatore?.ruolo === "admin" && <BottoneTest chiave={r.chiave} />}
                    {offriInoltro && (
                      <button
                        type="submit"
                        form={`inol-${r.chiave}`}
                        className="btn-mini"
                        title="Passa la recensione al customer care (Cherubina): apre il ticket e la sposta in «In attesa»; la risposta tornerà qui quando arriva."
                      >
                        Inoltra al customer care
                      </button>
                    )}
                    <AnteprimaFlusso titolo={`Cosa farà su «${r.nome || "questa recensione"}»`}>
                      <ol className="ap-lista">
                        {regola!.azioni.map((a) => (
                          <PassoAnteprima key={a.id} azione={a} />
                        ))}
                      </ol>
                    </AnteprimaFlusso>
                    <VediMail id={r.messaggioId} icona />
                    <BottoneArchivia chiave={r.chiave} />
                    <BottoneSegnala chiave={r.chiave} />
                  </div>
                </form>
              ) : regola ? (
                // Recensione NEGATIVA coperta dalla regola escalation (1-2★):
                // nessuna risposta automatica. Fase 1 = inoltro a Cherubina
                // (apre il ticket); la risposta tornerà qui quando la rimanda.
                <>
                  <p className="notice dash-senza-regola">
                    Recensione negativa: inoltrala al customer care per aprire la lavorazione —
                    la risposta tornerà qui quando arriva.
                  </p>
                  <div className="dash-azioni">
                    <form action={avviaEscalationAction} style={{ display: "contents" }}>
                      <input type="hidden" name="chiave" value={r.chiave} />
                      <input type="hidden" name="label" value={label?.id ?? ""} />
                      <button type="submit" className="btn-primary">
                        Inoltra al customer care
                      </button>
                    </form>
                    <VediMail id={r.messaggioId} icona />
                    <BottoneArchivia chiave={r.chiave} />
                    <BottoneSegnala chiave={r.chiave} />
                  </div>
                </>
              ) : tutte ? (
                // Con l'occhio acceso: recensione SENZA regola di risposta
                // (o senza regola). Box VUOTO da compilare e SOLO azioni
                // manuali: niente Rispondi, così non parte alcun flusso
                // automatico (né una pubblicazione «Grazie.» su una negativa).
                <form action={playAction} className="dash-proposta">
                  <input type="hidden" name="chiave" value={r.chiave} />
                  <input type="hidden" name="label" value={label?.id ?? ""} />
                  <CampoRisposta chiave={r.chiave} iniziale={bozza ?? ""} proposta="" vuoto />
                  <div className="dash-azioni">
                    {operatore?.ruolo === "admin" && <BottoneTest chiave={r.chiave} />}
                    <VediMail id={r.messaggioId} icona />
                    <BottoneArchivia chiave={r.chiave} />
                    <BottoneSegnala chiave={r.chiave} />
                  </div>
                </form>
              ) : (
                <>
                  <p className="notice dash-senza-regola">
                    Nessuna regola di risposta copre questa recensione: accendi una regola da{" "}
                    <Link href="/impostazioni#automazioni">Impostazioni</Link>.
                  </p>
                  <div className="dash-azioni">
                    <VediMail id={r.messaggioId} icona />
                    <BottoneArchivia chiave={r.chiave} />
                    <BottoneSegnala chiave={r.chiave} />
                  </div>
                </>
              )}
            </article>
          );
        })
      )}

      {daApprovare.length > 0 && (totalePagine > 1 || dimensionePagina !== PAGINA_DEFAULT) && (
        <nav className="appr-paginazione" aria-label="Pagine di «Da approvare»">
          <p className="hint">
            Pagina {numeroPagina} di {totalePagine} · {daApprovare.length} recensioni in tutto
          </p>
          <div className="appr-paginazione-pagine">
            {numeroPagina > 1 ? (
              <Link
                href={urlLista({ n: dimensionePagina, p: numeroPagina - 1 })}
                className="btn-mini"
                aria-label="Pagina precedente"
              >
                ‹ Precedente
              </Link>
            ) : (
              <span className="btn-mini is-disabilitato" aria-hidden="true">
                ‹ Precedente
              </span>
            )}
            {numeriPagina(numeroPagina, totalePagine).map((voce, i) =>
              voce === "…" ? (
                <span key={`ellissi-${i}`} className="appr-ellissi" aria-hidden="true">
                  …
                </span>
              ) : (
                <Link
                  key={voce}
                  href={urlLista({ n: dimensionePagina, p: voce })}
                  className={`btn-mini${voce === numeroPagina ? " is-active" : ""}`}
                  aria-current={voce === numeroPagina ? "page" : undefined}
                >
                  {voce}
                </Link>
              ),
            )}
            {numeroPagina < totalePagine ? (
              <Link
                href={urlLista({ n: dimensionePagina, p: numeroPagina + 1 })}
                className="btn-mini"
                aria-label="Pagina successiva"
              >
                Successiva ›
              </Link>
            ) : (
              <span className="btn-mini is-disabilitato" aria-hidden="true">
                Successiva ›
              </span>
            )}
          </div>
          <div className="appr-paginazione-dimensione">
            <span className="hint">Per pagina:</span>
            {PAGINE_SCELTE.map((k) => (
              <Link
                key={k}
                href={urlLista({ n: k })}
                className={`btn-mini${dimensionePagina === k ? " is-active" : ""}`}
                title={`Mostra ${k} recensioni per pagina`}
              >
                {k}
              </Link>
            ))}
            <Link
              href={urlLista({ n: PAGINA_MAX })}
              className={`btn-mini${dimensionePagina >= PAGINA_MAX ? " is-active" : ""}`}
              title="Tutte le recensioni in una pagina sola"
            >
              Tutte
            </Link>
          </div>
        </nav>
      )}
    </section>
  );
}
