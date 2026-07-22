import Link from "next/link";
import { modoInVigoreDa } from "@/server/db/impostazioni";
import { loadSettings } from "@/server/settings";
import {
  coperturaRegole,
  copertura,
  lavorazione,
  lingue,
  perSede,
  perSettimana,
  punteggi,
  SOGLIA_SEDE,
} from "@/server/statistiche/query";
import { isTranslationConfigured } from "@/server/translate";
import { settimanaIso } from "@/server/tempo";

// Statistiche sull'archivio.
//
// Il criterio che governa questa pagina è uno solo: non far sembrare vero un
// numero che non lo è. Lo storico comincia dal giorno in cui è nato l'archivio,
// la modalità simulazione non pubblica niente, e sotto una certa base una
// percentuale è rumore. Dove il dato non regge, la pagina lo dice invece di
// mostrare un grafico convincente.

export const dynamic = "force-dynamic";
export const metadata = { title: "Statistiche — Galdieri rent" };

const data = new Intl.DateTimeFormat("it-IT", { dateStyle: "medium" });
const dataOra = new Intl.DateTimeFormat("it-IT", { dateStyle: "medium", timeStyle: "short" });

function Riquadro({
  titolo,
  valore,
  base,
}: {
  titolo: string;
  valore: string | number;
  base?: string;
}) {
  return (
    <div className="stat-tile">
      <div className="stat-valore">{valore}</div>
      <div className="stat-titolo">{titolo}</div>
      {base && <div className="stat-base">{base}</div>}
    </div>
  );
}

export default async function StatistichePage() {
  const settings = await loadSettings();
  const simulazione = settings.modo !== "reale";
  const traduzioneAttiva = await isTranslationConfigured();

  const cop = copertura();
  const settimane = perSettimana();
  const p = punteggi();
  const sedi = perSede();
  const lin = lingue();
  const lav = lavorazione();
  const regole = coperturaRegole();
  const modoDa = modoInVigoreDa();

  const settimanaCorrente = settimanaIso(new Date().toISOString());
  const complete = settimane.filter((s) => s.settimana !== settimanaCorrente);
  const mediaSettimanale =
    complete.length > 0
      ? complete.reduce((s, x) => s + x.recensioni, 0) / complete.length
      : null;
  const massimo = Math.max(1, ...settimane.map((s) => s.recensioni));

  if (cop.recensioni === 0) {
    return (
      <main>
        <h1>Statistiche</h1>
        <section className="card">
          <p className="hint">
            L&apos;archivio è ancora vuoto. Si riempie da solo aprendo{" "}
            <Link href="/recensioni">Recensioni</Link> o la{" "}
            <Link href="/dashboard">Dashboard</Link>: ogni lettura della posta archivia quello che
            trova, e da lì in poi le recensioni restano anche quando escono dalle ultime 50 email.
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="dash">
      <h1>Statistiche</h1>
      <p className="subtitle">
        Calcolate sull&apos;archivio: {cop.recensioni} recensioni conservate, non sulle ultime email
        lette.
      </p>

      {/* ---------------------------------------------- copertura, in cima */}
      <section className="card">
        <div className="sec-head">
          <h2>Copertura dei dati</h2>
          <span className={`conn-badge ${simulazione ? "conn-ok" : "conn-ko"}`}>
            {simulazione ? "simulazione" : "MODALITÀ REALE"}
          </span>
        </div>
        <p className="notice">
          <strong>
            I grafici temporali cominciano dal giorno di prima raccolta
            {cop.primaRaccolta ? `, il ${data.format(new Date(cop.primaRaccolta))}` : ""}.
          </strong>{" "}
          Prima di quella data non c&apos;è assenza di recensioni: c&apos;è assenza di dati.
          {modoDa && (
            <>
              {" "}
              La modalità in vigore è cambiata l&apos;ultima volta il{" "}
              {dataOra.format(new Date(modoDa))}.
            </>
          )}
        </p>
        <div className="stat-griglia">
          <Riquadro titolo="Recensioni in archivio" valore={cop.recensioni} base={`${cop.giorniCoperti} giorni coperti`} />
          <Riquadro titolo="Letture della posta" valore={cop.sincronizzazioni} base={`${cop.messaggiLetti} email lette`} />
          <Riquadro titolo="Email non interpretabili" valore={cop.messaggiScartati} base="non contenevano una recensione" />
          <Riquadro titolo="Senza punteggio" valore={cop.senzaPunteggio} base="mai contate come zero stelle" />
          <Riquadro titolo="Sede non riconosciuta" valore={cop.senzaSede} base="restano nei totali" />
          <Riquadro titolo="Possibili doppioni" valore={cop.possibiliDoppioni} base="stesso testo, chiavi diverse" />
        </div>
        {cop.ricostruite > 0 && (
          <p className="hint">
            {cop.ricostruite} recensioni sono state ricostruite dal registro esecuzioni: di quelle
            il testo è tagliato a 400 caratteri, non è così che le ha scritte il cliente.
          </p>
        )}
      </section>

      {/* -------------------------------------------------------- volume */}
      <section className="card">
        <h2>Volume per settimana</h2>
        <p className="hint">
          {mediaSettimanale !== null
            ? `Media ${mediaSettimanale.toFixed(1)} a settimana, calcolata solo sulle ${complete.length} settimane intere.`
            : "Nessuna settimana intera ancora conclusa: la media arriverà."}{" "}
          La settimana in corso è tratteggiata e resta fuori dalle medie.
        </p>
        <div className="stat-barre">
          {settimane.map((s) => (
            <div key={s.settimana} className="stat-barra-gruppo">
              <div
                className={`stat-barra${s.settimana === settimanaCorrente ? " stat-barra-parziale" : ""}`}
                style={{ height: `${Math.round((s.recensioni / massimo) * 100)}%` }}
                title={`${s.settimana}: ${s.recensioni} recensioni, ${s.negative} negative`}
              >
                <span className="stat-barra-valore">{s.recensioni}</span>
              </div>
              <span className="stat-barra-etichetta">{s.settimana.replace(/^\d{4}-/, "")}</span>
            </div>
          ))}
        </div>
      </section>

      {/* ----------------------------------------------------- punteggio */}
      <section className="card">
        <h2>Punteggio</h2>
        <p className="hint">
          Base: {p.base} recensioni con punteggio riconosciuto
          {p.senzaPunteggio > 0 ? `, ${p.senzaPunteggio} senza` : ""}.
          {p.media !== null && ` Media ${p.media.toFixed(2)}.`} È la media delle recensioni arrivate
          via email, non il punteggio pubblico del profilo Google: sono due insiemi diversi e non
          vanno confrontati.
        </p>
        <div className="stat-righe">
          {[5, 4, 3, 2, 1].map((n) => {
            const riga = p.distribuzione.find((d) => d.stelle === n);
            const quante = riga?.quante ?? 0;
            const quota = p.base > 0 ? (quante / p.base) * 100 : 0;
            return (
              <div key={n} className="stat-riga">
                <span className={`stars-badge stars-${n}`}>
                  {"★".repeat(n)}
                  <span className="stars-empty">{"★".repeat(5 - n)}</span>
                </span>
                {/* Sotto soglia la barra non si disegna: nascondere il numero
                    "67%" ma lasciare una barra che occupa due terzi della riga
                    comunica esattamente la percentuale che si voleva tacere. */}
                <div className="stat-riga-barra">
                  {p.base >= SOGLIA_SEDE && (
                    <div className={`stat-riga-piena s${n}`} style={{ width: `${quota}%` }} />
                  )}
                </div>
                <span className="stat-riga-valore">
                  {quante}
                  {p.base >= SOGLIA_SEDE && <span className="muted"> · {quota.toFixed(0)}%</span>}
                </span>
              </div>
            );
          })}
        </div>
        <div className="stat-griglia">
          <Riquadro titolo="5★ senza commento" valore={p.cinqueSenzaCommento} base="il caso più automatizzabile" />
          <Riquadro titolo="5★ con commento" valore={p.cinqueConCommento} base="richiedono una risposta nel merito" />
          <Riquadro titolo="1-2★" valore={p.negative} base="passano dal customer care" />
        </div>
        {p.base < SOGLIA_SEDE && (
          <p className="notice">
            Sotto le {SOGLIA_SEDE} recensioni le percentuali non compaiono: su una base così piccola
            un solo cliente sposta di dieci punti.
          </p>
        )}
      </section>

      {/* ---------------------------------------------------------- sedi */}
      <section className="card">
        <h2>Sedi</h2>
        <p className="notice">
          <strong>Non esiste il denominatore.</strong> Non sappiamo quanti noleggi ha fatto ogni
          sede, quindi «la sede con più recensioni negative» è una frase onesta, «la sede peggiore»
          no.
        </p>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Sede</th>
                <th>Recensioni</th>
                <th>Negative</th>
                <th>Media</th>
              </tr>
            </thead>
            <tbody>
              {sedi.map((s) => (
                <tr key={s.sede}>
                  <td>{s.sede}</td>
                  <td>{s.recensioni}</td>
                  <td>
                    {s.negative}
                    {s.baseSufficiente && s.recensioni > 0 && (
                      <span className="muted">
                        {" "}
                        · {((s.negative / s.recensioni) * 100).toFixed(0)}%
                      </span>
                    )}
                  </td>
                  <td>
                    {s.media !== null ? s.media.toFixed(2) : "—"}
                    {!s.baseSufficiente && <span className="muted"> · base piccola</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* -------------------------------------------------------- lingue */}
      <section className="card">
        <h2>Testo e lingua</h2>
        {traduzioneAttiva ? (
          <>
            <p className="hint">
              {lin.conCommento} con commento, {lin.soloPunteggio} solo punteggio.
              {lin.lunghezzaMediana !== null &&
                ` Lunghezza mediana del commento: ${lin.lunghezzaMediana} caratteri.`}
            </p>
            <div className="stat-griglia">
              {lin.righe.map((r) => (
                <Riquadro key={r.lingua} titolo={r.lingua} valore={r.quante} />
              ))}
            </div>
          </>
        ) : (
          <p className="notice">
            Traduzione non attiva: il dato sulle lingue non è disponibile. A traduttore spento non
            varrebbe zero, varrebbe niente — e mostrarlo come «100% italiano» sarebbe una bugia.
          </p>
        )}
      </section>

      {/* --------------------------------------------------- lavorazione */}
      <section className="card">
        <h2>Lavorazione</h2>
        <p className="hint">
          Copertura delle regole: <strong>{regole.coperte}</strong> recensioni in coda sono coperte
          da una regola attiva, <strong>{regole.scoperte}</strong> no. È il numero più affidabile di
          questa pagina: non dipende dalla modalità operativa e vale dal primo giorno.
        </p>
        <div className="stat-griglia">
          <Riquadro titolo="Flussi simulati" valore={lav.flussiSimulati} base="nessuna scrittura verso l'esterno" />
          <Riquadro titolo="Flussi eseguiti davvero" valore={lav.flussiReali} base="in modalità reale" />
          {/* La didascalia segue il VALORE, non la modalità di adesso: dopo
              una mattinata in reale e un ritorno alla simulazione, un numero
              diverso da zero sotto la scritta «zero» è solo confusione. */}
          <Riquadro
            titolo="Risposte pubblicate su Google"
            valore={lav.pubblicateDavvero}
            base={
              lav.pubblicateDavvero === 0 && simulazione
                ? "zero: in simulazione non parte niente"
                : "solo risposte pubbliche al cliente, non inoltri né ticket"
            }
          />
          <Riquadro
            titolo="Altre scritture riuscite"
            valore={lav.scrittureRiuscite}
            base="inoltri, ticket e risposte email in modalità reale"
          />
          <Riquadro titolo="Testi riscritti a mano" valore={lav.riscritture} base="misura la qualità delle regole" />
          <Riquadro titolo="Flussi con errore" valore={lav.conErrore} />
          <Riquadro
            titolo="Ticket agganciati"
            valore={`${lav.ticketTrovati} / ${lav.ticketTrovati + lav.ticketNonTrovati}`}
            base="ricerca reale anche in simulazione"
          />
        </div>
        {lav.erroriPerNodo.length > 0 && (
          <p className="hint">
            Errori per passaggio:{" "}
            {lav.erroriPerNodo.map((e) => `${e.titolo} (${e.quanti})`).join(", ")}.
          </p>
        )}
      </section>

      <section className="card">
        <h2>Cosa non si può ancora dire</h2>
        <ul className="stat-limiti">
          <li>
            <strong>Confronti con i mesi passati:</strong> l&apos;archivio nasce ora. Mesi vuoti si
            leggerebbero come un crollo, non come assenza di dati.
          </li>
          <li>
            <strong>Prima e dopo l&apos;automazione:</strong> non esiste un «prima» raccolto con lo
            stesso metodo.
          </li>
          <li>
            <strong>Stagionalità:</strong> nel noleggio è fortissima. Confrontare luglio con novembre
            senza un anno intero di base non è un confronto, è un artefatto.
          </li>
          <li>
            <strong>Tempo di risposta al cliente:</strong> si sa misurare il tempo dall&apos;arrivo
            dell&apos;email, non da quando il cliente ha scritto la recensione. Quello vero è più
            lungo.
          </li>
          <li>
            <strong>Chi lavora da Outlook non lascia traccia:</strong> le risposte scritte fuori da
            qui si vedono come «già risposta», ma non se ne conosce il momento esatto.
          </li>
        </ul>
      </section>
    </main>
  );
}
