import Link from "next/link";
import { richiediAdmin } from "@/server/auth/sessione";
import { elencoUtenti } from "@/server/auth/utenti";
import { ticketDiEscalation } from "@/server/db/escalation";
import {
  contaApertePeriodo,
  contaGestitePeriodo,
  elencoAperte,
  elencoChiuse,
  type Segnalazione,
} from "@/server/db/segnalazioni";
import {
  gestionePerStelle,
  gestiteNelGiorno,
  modifichePerStelle,
  type Intervallo,
  type VoceGestita,
} from "@/server/statistiche/query";
import { inizioGiornoItaliano } from "@/server/tempo";
import { leggiStatoPilota } from "@/server/automation/pilota";
import { Stelle } from "../da-pubblicare/Voci";
import { ListaSegnalazioni } from "./ListaSegnalazioni";

// Supervisione: riservata all'amministratore. Nell'ordine in cui serve (scelta
// di Mario, 23/9/2026):
//   1. le SEGNALAZIONI APERTE: le recensioni che un operatore o l'automazione
//      hanno passato all'amministratore. Sono lavoro che aspetta lui, quindi
//      stanno in cima — prima erano in fondo, dopo due schermate di numeri, e
//      questa lista NON segue il periodo: è la coda di ADESSO;
//   2. OGGI, diviso per chi ha lavorato: il sistema da solo, una persona dal
//      portale, o qualcuno dalla posta senza passare di qui. Con l'elenco sotto
//      ogni gruppo: dopo «quante» la domanda è sempre «quali»;
//   3. i numeri del periodo scelto (gestite per punteggio, segnalazioni, testi
//      riscritti);
//   4. le segnalazioni già chiuse.
//
// Le tabelle usano `data-table-schede`: sul telefono ogni riga diventa una
// scheda con le etichette a sinistra, invece di una tabella che scorre di lato e
// di cui si vede solo la prima colonna.

export const dynamic = "force-dynamic";

const fmt = new Intl.DateTimeFormat("it-IT", { dateStyle: "medium", timeStyle: "short" });
const data = new Intl.DateTimeFormat("it-IT", { dateStyle: "medium" });
const oraFmt = new Intl.DateTimeFormat("it-IT", { hour: "2-digit", minute: "2-digit" });
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

// I quattro periodi richiesti: giorni pieni, non mesi di calendario — così la
// finestra è sempre esatta e prevedibile, invece di dipendere da quanti giorni
// ha il mese in corso.
const PERIODI = [
  { chiave: "7", giorni: 7, etichetta: "7 giorni" },
  { chiave: "30", giorni: 30, etichetta: "30 giorni" },
  { chiave: "90", giorni: 90, etichetta: "3 mesi" },
  { chiave: "270", giorni: 270, etichetta: "9 mesi" },
] as const;
// 7 giorni: la finestra su cui si decide qualcosa. A 30 il numero si mangia
// dentro settimane in cui si lavorava in un altro modo, e la fotografia di come
// vanno le cose ADESSO non si vede più.
const PERIODO_DEFAULT = "7";

function periodoDa(chiave: string | undefined): (typeof PERIODI)[number] {
  return PERIODI.find((p) => p.chiave === chiave) ?? PERIODI.find((p) => p.chiave === PERIODO_DEFAULT)!;
}

/** Sotto questa base le percentuali per riga sono rumore e non si mostrano. */
const SOGLIA_BASE = 20;
/** Le esecuzioni sono molte meno delle ricevute: la soglia per «% modificati» è più bassa. */
const SOGLIA_ESEGUITI = 5;

function quota(n: number, base: number, soglia = SOGLIA_BASE): string {
  return base >= soglia ? ` · ${Math.round((n / base) * 100)}%` : "";
}

/**
 * La riga sotto ai numeri di «Oggi». Qui la percentuale si mostra sempre, anche
 * su basi piccole: non è una statistica da cui trarre conclusioni, è la
 * ripartizione esatta di una giornata — «4 su 12» si legge e basta.
 */
function quotaOggi(n: number, totale: number): string {
  return totale > 0 ? `${n} su ${totale} · ${Math.round((n / totale) * 100)}%` : "nessuna, per ora";
}

/**
 * Un gruppo delle gestite di oggi: titolo, conteggio, una riga di spiegazione e
 * l'elenco. La tabella è `data-table-schede`: sul telefono ogni riga diventa una
 * scheda con l'etichetta a sinistra (`data-etichetta`), invece di scorrere di
 * lato mostrando solo la prima colonna.
 */
function GruppoGestite({
  titolo,
  spiega,
  vuoto,
  voci,
  chiPer,
  mostraChi,
  mostraRisposta = true,
}: {
  titolo: string;
  spiega: string;
  vuoto: string;
  voci: VoceGestita[];
  chiPer: (id: number | null) => string;
  mostraChi: boolean;
  mostraRisposta?: boolean;
}) {
  return (
    <div className="gestite-gruppo">
      <div className="sec-head">
        <h3 className="supervisione-sottotitolo">{titolo}</h3>
        {voci.length > 0 && <span className="chip-count">{voci.length}</span>}
      </div>
      <p className="hint">{spiega}</p>
      {voci.length === 0 ? (
        <p className="dash-vuoto">{vuoto}</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table data-table-compatta data-table-schede">
            <thead>
              <tr>
                <th>Ora</th>
                <th>Punteggio</th>
                <th>Cliente</th>
                {mostraChi && <th>Chi</th>}
                {mostraRisposta && <th>Risposta pubblicata</th>}
              </tr>
            </thead>
            <tbody>
              {voci.map((v) => (
                <tr key={v.chiave}>
                  <td data-etichetta="Ora">{oraFmt.format(new Date(v.quando))}</td>
                  <td data-etichetta="Punteggio">
                    {v.stelle !== null ? <Stelle n={v.stelle} /> : <span className="muted">—</span>}
                  </td>
                  <td data-etichetta="Cliente">{v.nomeCliente}</td>
                  {mostraChi && <td data-etichetta="Chi">{chiPer(v.chi)}</td>}
                  {mostraRisposta && (
                    <td data-etichetta="Risposta">
                      {v.risposta ? (
                        <span title={v.risposta}>
                          {v.risposta.length > 70 ? `${v.risposta.slice(0, 70)}…` : v.risposta}
                        </span>
                      ) : (
                        <span className="muted">non passata di qui</span>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Riquadro({ titolo, valore, base }: { titolo: string; valore: string | number; base?: string }) {
  return (
    <div className="stat-tile">
      <div className="stat-valore">{valore}</div>
      <div className="stat-titolo">{titolo}</div>
      {base && <div className="stat-base">{base}</div>}
    </div>
  );
}

export default async function SupervisionePage({
  searchParams,
}: {
  searchParams: Promise<{ periodo?: string }>;
}) {
  await richiediAdmin();
  const sp = await searchParams;
  const periodoSel = periodoDa(sp.periodo);
  const al = new Date();
  const dal = new Date(al.getTime() - periodoSel.giorni * 24 * 60 * 60 * 1000);
  const intervallo: Intervallo = { dal, al };

  // «Oggi» sta FUORI dai tab del periodo: è la fotografia della giornata in
  // corso e non deve cambiare quando si sfoglia 7/30/90 giorni.
  const inizioOggi = inizioGiornoItaliano(al);

  const [righe, modifiche, apertePeriodo, gestitePeriodo, oggi, aperte, chiuse, utenti, pilota] =
    await Promise.all([
      gestionePerStelle(intervallo),
      modifichePerStelle(intervallo),
      contaApertePeriodo(dal, al),
      contaGestitePeriodo(dal, al),
      gestiteNelGiorno(inizioOggi, al),
      elencoAperte(),
      elencoChiuse(),
      elencoUtenti(),
      leggiStatoPilota(),
    ]);
  const nomeDi = new Map<number, string>(utenti.map((u) => [u._id, u.nome]));
  const chiPer = (id: number | null) => (id === null ? "—" : nomeDi.get(id) ?? (id === 1 ? "Sistema" : `#${id}`));

  // I tre gruppi della giornata. Si dividono qui e non in una query a parte:
  // `gestiteNelGiorno` porta già la riga per riga, e tre passaggi su una lista
  // di poche decine di voci non costano niente.
  const dalSistemaOggi = oggi.dettaglio.filter((v) => v.via === "portale" && v.metodo === "automatico");
  const aManoOggi = oggi.dettaglio.filter((v) => v.via === "portale" && v.metodo !== "automatico");
  const dallaPostaOggi = oggi.dettaglio.filter((v) => v.via === "posta");

  // Il ticket Freshdesk che conosciamo per ciascuna segnalata (se c'è).
  const ticketPer = new Map(
    await Promise.all(aperte.map(async (s) => [s.chiave, await ticketDiEscalation(s.chiave)] as const)),
  );

  // Totali del periodo: la somma delle righe per stella, non una query a parte.
  const g = righe.reduce(
    (acc, r) => ({
      ricevute: acc.ricevute + r.ricevute,
      conRisposta: acc.conRisposta + r.conRisposta,
      dalSistema: acc.dalSistema + r.dalSistema,
      dalCrm: acc.dalCrm + r.dalCrm,
      fuoriCrm: acc.fuoriCrm + r.fuoriCrm,
    }),
    { ricevute: 0, conRisposta: 0, dalSistema: 0, dalCrm: 0, fuoriCrm: 0 },
  );
  const modifichePer = new Map(modifiche.map((m) => [m.stelle, m]));
  const conPunteggio = righe.filter((r) => r.stelle !== null);
  const senzaPunteggio = righe.find((r) => r.stelle === null);
  const modSenzaPunteggio = modifichePer.get(null);
  const modTotale = modifiche.reduce(
    (acc, m) => ({ eseguiti: acc.eseguiti + m.eseguiti, modificati: acc.modificati + m.modificati }),
    { eseguiti: 0, modificati: 0 },
  );
  const perc = (n: number) => (g.ricevute > 0 ? `${Math.round((n / g.ricevute) * 100)}% delle ricevute` : undefined);

  return (
    <main className="dash">
      <h1>Supervisione</h1>
      <p className="subtitle">
        Riservata all&apos;amministratore: i numeri del periodo scelto e le recensioni che gli
        operatori hanno segnalato perché non riuscivano a gestirle.
      </p>

      {/* -------------------------------------------------- segnalazioni aperte */}
      {/* In cima: è l'unica cosa in questa pagina che chiede un'azione a chi la
          apre. La lista sta nel browser — chiudere una segnalazione è un clic e
          la card deve sparire subito — ma il contenuto lo prepara il server
          (prop `contenuto`), così testi e formattatori non finiscono nel
          pacchetto JavaScript. */}
      <section className="card">
        <ListaSegnalazioni
          nota={
            <p className="hint">
              Recensioni che un operatore ha passato a te col tasto «?», o che l&apos;automazione ha
              lasciato a una persona dopo due tentativi falliti. Finché stanno qui, chi le ha
              segnalate non le vede più. <strong>«Chiudi: già gestita»</strong> la chiude davvero —
              risulta gestita anche nelle statistiche e finisce in «Archiviate», dove resta leggibile
              col motivo e si può ripristinare: è il tasto per quando ti dicono «questa era già
              fatta». <strong>«Rimetti in coda»</strong> la fa ricomparire in «Da approvare»
              dell&apos;operatore. <strong>«Test»</strong> manda il robot a cercare QUELLA recensione
              su Google e ti riporta il passo-passo, senza pubblicare niente: è il modo per capire un
              «non lo trova» invece di indovinarlo.
            </p>
          }
          voci={aperte.map((s) => ({
            chiave: s.chiave,
            nome: s.nomeCliente,
            messaggioId: s.messaggioId,
            contenuto: (
              <ContenutoSegnalazione
                s={s}
                chi={chiPer(s.segnalataDa)}
                ticket={ticketPer.get(s.chiave) ?? null}
              />
            ),
          }))}
        />
      </section>

      {/* --------------------------------------------------------------- oggi */}
      {/* Fuori dai tab di proposito: è la giornata in corso, non un periodo da
          sfogliare. Divisa per CHI ha lavorato, perché con il pilota acceso
          «gestite 12» non dice più niente: la domanda è quante ha fatto il
          sistema da solo, quante una persona, e quante sono passate fuori di qui. */}
      <section className="card">
        <div className="sec-head">
          <h2>Oggi</h2>
          <span className="muted">{dataConGiorno(al)}</span>
        </div>
        <div className="stat-griglia">
          <Riquadro titolo="Recensioni gestite oggi" valore={oggi.totale} base="dalla mezzanotte" />
          <Riquadro
            titolo="🤖 Dal sistema"
            valore={dalSistemaOggi.length}
            base={quotaOggi(dalSistemaOggi.length, oggi.totale)}
          />
          <Riquadro
            titolo="A mano, dal portale"
            valore={aManoOggi.length}
            base={quotaOggi(aManoOggi.length, oggi.totale)}
          />
          <Riquadro
            titolo="Dalla posta"
            valore={dallaPostaOggi.length}
            base={quotaOggi(dallaPostaOggi.length, oggi.totale)}
          />
        </div>

        {/* Gli elenchi dei tre numeri qui sopra: senza, «3 gestite» non si può né
            controllare né contestare. Stanno qui e non in una pagina a parte
            perché la domanda «quali?» viene sempre subito dopo «quante?». Una
            giornata sono poche righe: nessun bisogno di impaginarle. */}
        <GruppoGestite
          titolo="🤖 Gestite dal sistema"
          spiega="Pubblicate dall'automazione, senza che nessuno premesse «Rispondi»."
          vuoto="Oggi il sistema non ha ancora pubblicato niente."
          voci={dalSistemaOggi}
          chiPer={chiPer}
          mostraChi={false}
        />
        <GruppoGestite
          titolo="Gestite a mano, dal portale"
          spiega="Qualcuno ha premuto «Rispondi» qui dentro: la risposta è pubblicata e il ticket chiuso."
          vuoto="Oggi nessuno ha pubblicato a mano dal portale."
          voci={aManoOggi}
          chiPer={chiPer}
          mostraChi
        />
        <GruppoGestite
          titolo="Gestite dalla posta, fuori dal portale"
          spiega="Qualcuno di Galdieri ha scritto dalla casella senza passare di qui: può essere la risposta al cliente o il semplice inoltro al customer care. Il testo non lo conosciamo."
          vuoto="Oggi non è passato niente fuori dal portale."
          voci={dallaPostaOggi}
          chiPer={chiPer}
          mostraChi={false}
          mostraRisposta={false}
        />

        {/* Senza questa riga un pilota fermo — Chrome aperto sul server, sessione
            Google scaduta, AUTOPILOTA non impostato — sarebbe invisibile: le
            recensioni resterebbero lì e nessuno saprebbe perché. */}
        <p className="hint">
          🤖 Automazione:{" "}
          {pilota
            ? `ultimo giro alle ${oraFmt.format(new Date(pilota.ultimoGiro))} — ${pilota.messaggio}`
            : "non è mai partita su questo server (serve AUTOPILOTA=1 nel .env)."}
        </p>
        <p className="hint">
          «Gestite» non vuol dire «chiuse». I primi due gruppi sì: sono risposte pubblicate da
          questo sito oggi, e quelle sono finite. Il terzo no: sono recensioni su cui qualcuno di
          Galdieri ha scritto dalla casella senza passare di qui, e lì dentro finiscono due cose
          diverse — la risposta vera al cliente e il semplice inoltro al customer care, che è lavoro
          fatto ma lascia la recensione ancora da chiudere. La posta non permette di distinguerle in
          modo affidabile, quindi il numero le tiene insieme: è la misura di quanto lavoro passa
          ancora fuori dal portale, non di quanto è concluso. Per quelle, la data è il momento in
          cui il portale se n&apos;è accorto — rilegge la posta ogni pochi minuti — non per forza
          l&apos;istante dell&apos;invio. Chi compare da tutte e due le parti è contato una volta
          sola.
        </p>
      </section>

      {/* ------------------------------------------------------------ periodo */}
      <nav className="pub-tabs" aria-label="Periodo">
        {PERIODI.map((p) => (
          <Link
            key={p.chiave}
            href={p.chiave === PERIODO_DEFAULT ? "/supervisione" : `/supervisione?periodo=${p.chiave}`}
            className={`pub-tab${p.chiave === periodoSel.chiave ? " is-active" : ""}`}
          >
            {p.etichetta}
          </Link>
        ))}
      </nav>

      {/* ------------------------------------------------ recensioni gestite */}
      <section className="card">
        <h2>Statistiche del periodo</h2>
        <p className="hint">
          Dal {data.format(dal)} a oggi ({periodoSel.etichetta}). Le recensioni contano nella coorte
          in cui sono state RICEVUTE, anche se gestite dopo la fine della finestra.
        </p>
        <div className="stat-griglia">
          <Riquadro titolo="Gestite dal CRM" valore={g.dalCrm} base={perc(g.dalCrm)} />
          <Riquadro
            titolo="Fuori dal CRM"
            valore={g.fuoriCrm}
            base={g.fuoriCrm > 0 ? perc(g.fuoriCrm) : "nessuna: passano tutte da qui"}
          />
          <Riquadro titolo="Pubblicate dal portale" valore={g.dalSistema} base={perc(g.dalSistema)} />
          <Riquadro titolo="Recensioni ricevute" valore={g.ricevute} base={`ultimi ${periodoSel.etichetta}`} />
        </div>
        <p className="hint">
          <strong>Gestite dal CRM</strong> sono tutte quelle di cui si occupa questo sistema, finite
          o no: pubblicate su Google, in attesa del customer care, con un ticket Freshdesk aperto,
          archiviate a mano, e anche quelle ancora da fare — sono in coda qui, non le sta gestendo
          nessun altro. Restano fuori solo le recensioni a cui qualcuno ha risposto da Outlook senza
          passare di qui: quelle sono <strong>Fuori dal CRM</strong>, ed è il numero da tenere
          d&apos;occhio. <strong>Pubblicate dal portale</strong> è invece il lavoro concluso, quindi
          è sempre più basso: una recensione inoltrata a Cherubina ieri è gestita dal CRM ma non è
          ancora pubblicata.
        </p>

        <h3 className="supervisione-sottotitolo">Segnalazioni nel periodo</h3>
        <div className="stat-griglia">
          <Riquadro titolo="Aperte" valore={apertePeriodo} base="passate all'amministratore" />
          <Riquadro titolo="Gestite" valore={gestitePeriodo} base="risolte o rimesse in coda" />
        </div>

        <h3 className="supervisione-sottotitolo">Per punteggio</h3>
        <div className="table-wrap">
          <table className="data-table data-table-compatta data-table-schede supervisione-stelle">
            <thead>
              <tr>
                <th>Punteggio</th>
                <th>Ricevute</th>
                <th>Gestite dal CRM</th>
                <th>Pubblicate dal portale</th>
                <th>Testi modificati</th>
              </tr>
            </thead>
            <tbody>
              {conPunteggio.map((r) => {
                const m = modifichePer.get(r.stelle);
                return (
                  <tr key={r.stelle}>
                    <td data-etichetta="Punteggio">
                      <Stelle n={r.stelle} />
                    </td>
                    <td data-etichetta="Ricevute">{r.ricevute}</td>
                    <td data-etichetta="Gestite dal CRM">
                      {r.dalCrm}
                      <span className="muted">{quota(r.dalCrm, r.ricevute)}</span>
                    </td>
                    <td data-etichetta="Pubblicate dal portale">
                      {r.dalSistema}
                      <span className="muted">{quota(r.dalSistema, r.ricevute)}</span>
                    </td>
                    <td data-etichetta="Testi modificati">
                      {m && m.eseguiti > 0 ? (
                        <>
                          {m.modificati} / {m.eseguiti}
                          <span className="muted">{quota(m.modificati, m.eseguiti, SOGLIA_ESEGUITI)}</span>
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {senzaPunteggio && senzaPunteggio.ricevute > 0 && (
                <tr>
                  <td className="muted" data-etichetta="Punteggio">
                    senza punteggio
                  </td>
                  <td data-etichetta="Ricevute">{senzaPunteggio.ricevute}</td>
                  <td data-etichetta="Gestite dal CRM">{senzaPunteggio.dalCrm}</td>
                  <td data-etichetta="Pubblicate dal portale">{senzaPunteggio.dalSistema}</td>
                  <td data-etichetta="Testi modificati">
                    {modSenzaPunteggio && modSenzaPunteggio.eseguiti > 0
                      ? `${modSenzaPunteggio.modificati} / ${modSenzaPunteggio.eseguiti}`
                      : "—"}
                  </td>
                </tr>
              )}
              <tr className="supervisione-totale">
                <td data-etichetta="Punteggio">Totale</td>
                <td data-etichetta="Ricevute">{g.ricevute}</td>
                <td data-etichetta="Gestite dal CRM">{g.dalCrm}</td>
                <td data-etichetta="Pubblicate dal portale">{g.dalSistema}</td>
                <td data-etichetta="Testi modificati">
                  {modTotale.eseguiti > 0 ? `${modTotale.modificati} / ${modTotale.eseguiti}` : "—"}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="hint">
          Sotto le {SOGLIA_BASE} recensioni ricevute (o le {SOGLIA_ESEGUITI} risposte eseguite, per
          «Testi modificati») la percentuale non compare: su una base così piccola un solo caso la
          sposta di parecchio. «Testi modificati» conta solo le risposte EFFETTIVAMENTE eseguite in
          questo periodo, non le ricevute: sono spesso insiemi diversi.
        </p>
      </section>

      {/* ------------------------------------------------ segnalazioni chiuse */}
      <section className="card">
        <h2>Segnalazioni chiuse</h2>
        {chiuse.length === 0 ? (
          <p className="hint">Ancora nessuna.</p>
        ) : (
          <ul className="segnalazioni-chiuse">
            {chiuse.map((s) => (
              <li key={s.chiave}>
                <div className="dash-autore-riga">
                  <span className="review-name">{s.nomeCliente || "senza nome"}</span>
                  <Stelle n={s.stelle} />
                  <span className={`flag ${s.stato === "risolta" ? "flag-green" : "flag-gray"}`}>
                    {s.stato === "risolta" ? "chiusa: già gestita" : "rimessa in coda"}
                  </span>
                </div>
                <div className="dash-meta">
                  {s.sedeNome ? `${s.sedeNome} · ` : ""}segnalata da {chiPer(s.segnalataDa)} il{" "}
                  {fmt.format(new Date(s.segnalataIl))}
                  {s.chiusaIl ? ` · chiusa da ${chiPer(s.chiusaDa)} il ${fmt.format(new Date(s.chiusaIl))}` : ""}
                </div>
                <p className="segnalazione-riga">
                  <strong>Problema:</strong> {s.nota}
                </p>
                {s.notaChiusura && (
                  <p className="segnalazione-riga">
                    <strong>Esito:</strong> {s.notaChiusura}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

/**
 * Il CONTENUTO della card, renderizzato dal server: intestazione, testo della
 * recensione, nota di chi l'ha segnalata, ticket collegato.
 *
 * I tasti NON stanno qui. Vivono in ListaSegnalazioni, lato browser, perche'
 * devono poter far sparire la card all'istante. Cosi' il pacchetto JavaScript
 * non si porta dietro ne' i testi delle recensioni ne' i formattatori di data.
 */
function ContenutoSegnalazione({
  s,
  chi,
  ticket,
}: {
  s: Segnalazione;
  chi: string;
  ticket: number | null;
}) {
  return (
    <>
      <header className="dash-card-testa">
        <div className="dash-autore">
          <span className="dash-iniziale" aria-hidden="true">
            {(s.nomeCliente || "?").trim().charAt(0).toUpperCase()}
          </span>
          <div>
            <div className="dash-autore-riga">
              <span className="review-name">{s.nomeCliente || "senza nome"}</span>
            </div>
            <div className="dash-meta">
              {dataConGiorno(new Date(s.ricevutaIl))} · {oraFmt.format(new Date(s.ricevutaIl))}
              {s.sedeNome ? ` · ${s.sedeNome}` : ""}
            </div>
          </div>
        </div>
        <div className="dash-scheda">
          <Stelle n={s.stelle} />
        </div>
      </header>

      {s.testoRecensione && <p className="review-comment">{s.testoRecensione}</p>}

      <div className="segnalazione-nota">
        <div className="segnalazione-nota-testa">
          Problema segnalato da <strong>{chi}</strong> · {fmt.format(new Date(s.segnalataIl))}
        </div>
        <p>{s.nota}</p>
      </div>

      {ticket && (
        <p className="hint">
          Ticket Freshdesk collegato: <Link href={`/ticket/${ticket}`}>#{ticket}</Link>
        </p>
      )}
    </>
  );
}
