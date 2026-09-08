import Link from "next/link";
import { richiediAdmin } from "@/server/auth/sessione";
import { elencoUtenti } from "@/server/auth/utenti";
import { ticketDiEscalation } from "@/server/db/escalation";
import { elencoAperte, elencoChiuse, type Segnalazione } from "@/server/db/segnalazioni";
import { gestione, gestionePerStelle } from "@/server/statistiche/query";
import { Stelle } from "../da-pubblicare/Voci";
import { VediMail } from "../VediMail";
import { rimettiInCodaSegnalazioneAction, risolviSegnalazioneAction } from "./actions";

// Supervisione: riservata all'amministratore. Due cose sole:
//   1. quante recensioni sono state gestite, spaccate per punteggio;
//   2. le recensioni che gli operatori hanno SEGNALATO perché non riuscivano a
//      gestirle, con la loro nota — da risolvere qui o rimandare in coda.

export const dynamic = "force-dynamic";
export const metadata = { title: "Supervisione — GaldieriReviews" };

const fmt = new Intl.DateTimeFormat("it-IT", { dateStyle: "medium", timeStyle: "short" });
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

/** Sotto questa base le percentuali per riga sono rumore e non si mostrano. */
const SOGLIA_BASE = 20;

function quota(n: number, base: number): string {
  return base >= SOGLIA_BASE ? ` · ${Math.round((n / base) * 100)}%` : "";
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

export default async function SupervisionePage() {
  await richiediAdmin();

  const [g, righe, aperte, chiuse, utenti] = await Promise.all([
    gestione(),
    gestionePerStelle(),
    elencoAperte(),
    elencoChiuse(),
    elencoUtenti(),
  ]);
  const nomeDi = new Map<number, string>(utenti.map((u) => [u._id, u.nome]));
  const chiPer = (id: number | null) => (id === null ? "—" : nomeDi.get(id) ?? (id === 1 ? "Sistema" : `#${id}`));

  // Il ticket Freshdesk che conosciamo per ciascuna segnalata (se c'è).
  const ticketPer = new Map(
    await Promise.all(aperte.map(async (s) => [s.chiave, await ticketDiEscalation(s.chiave)] as const)),
  );

  const senzaPunteggio = righe.find((r) => r.stelle === null);
  const conPunteggio = righe.filter((r) => r.stelle !== null);
  const perc = (n: number) => (g.ricevute > 0 ? `${Math.round((n / g.ricevute) * 100)}% delle ricevute` : undefined);

  return (
    <main className="dash">
      <h1>Supervisione</h1>
      <p className="subtitle">
        Riservata all&apos;amministratore: i numeri della gestione per punteggio e le recensioni che
        gli operatori hanno segnalato perché non riuscivano a gestirle.
      </p>

      {/* ------------------------------------------------ recensioni gestite */}
      <section className="card">
        <h2>Recensioni gestite</h2>
        <p className="hint">
          «Dal sistema» = risposte pubblicate da questo sito; «in totale» = recensioni con una
          risposta rilevata nella posta, anche scritta a mano da Outlook. Sono due misure diverse:
          si rapportano entrambe alle ricevute, non fra loro.
        </p>
        <div className="stat-griglia">
          <Riquadro titolo="Gestite dal sistema" valore={g.dalSistema} base={perc(g.dalSistema)} />
          <Riquadro titolo="Gestite in totale" valore={g.conRisposta} base={perc(g.conRisposta)} />
          <Riquadro titolo="Recensioni ricevute" valore={g.ricevute} base="l'intero archivio" />
        </div>
        <div className="table-wrap">
          <table className="data-table data-table-compatta supervisione-stelle">
            <thead>
              <tr>
                <th>Punteggio</th>
                <th>Ricevute</th>
                <th>Gestite dal sistema</th>
                <th>Gestite in totale</th>
              </tr>
            </thead>
            <tbody>
              {conPunteggio.map((r) => (
                <tr key={r.stelle}>
                  <td>
                    <Stelle n={r.stelle} />
                  </td>
                  <td>{r.ricevute}</td>
                  <td>
                    {r.dalSistema}
                    <span className="muted">{quota(r.dalSistema, r.ricevute)}</span>
                  </td>
                  <td>
                    {r.conRisposta}
                    <span className="muted">{quota(r.conRisposta, r.ricevute)}</span>
                  </td>
                </tr>
              ))}
              {senzaPunteggio && senzaPunteggio.ricevute > 0 && (
                <tr>
                  <td className="muted">senza punteggio</td>
                  <td>{senzaPunteggio.ricevute}</td>
                  <td>{senzaPunteggio.dalSistema}</td>
                  <td>{senzaPunteggio.conRisposta}</td>
                </tr>
              )}
              <tr className="supervisione-totale">
                <td>Totale</td>
                <td>{g.ricevute}</td>
                <td>{g.dalSistema}</td>
                <td>{g.conRisposta}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="hint">
          Sotto le {SOGLIA_BASE} recensioni ricevute per riga la percentuale non compare: su una base
          così piccola un solo cliente la sposta di parecchio.
        </p>
      </section>

      {/* ------------------------------------------------ segnalazioni aperte */}
      <section className="card">
        <div className="sec-head">
          <h2>Segnalazioni aperte</h2>
          {aperte.length > 0 && <span className="chip-count">{aperte.length}</span>}
        </div>
        <p className="hint">
          Recensioni che un operatore ha passato a te col tasto «?» perché non riusciva a
          gestirle. Finché stanno qui, lui non le vede più. «Risolta» le lascia fuori dalla sua
          coda; «Rimetti in coda» le fa ricomparire in «Da approvare».
        </p>
        {aperte.length === 0 ? (
          <p className="dash-vuoto">Nessuna segnalazione aperta.</p>
        ) : (
          aperte.map((s) => (
            <CardSegnalazione key={s.chiave} s={s} chi={chiPer(s.segnalataDa)} ticket={ticketPer.get(s.chiave) ?? null} />
          ))
        )}
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
                    {s.stato === "risolta" ? "risolta" : "rimessa in coda"}
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

function CardSegnalazione({ s, chi, ticket }: { s: Segnalazione; chi: string; ticket: number | null }) {
  const rimetti = `rimetti-${s.chiave}`;
  return (
    <article className="card dash-card segnalazione-card">
      {/* «Rimetti in coda» non ha un form suo visibile: invia questo, via attributo form=,
          così sta in fila con «Risolta» senza annidare form. */}
      <form id={rimetti} action={rimettiInCodaSegnalazioneAction} className="dash-arch-form">
        <input type="hidden" name="chiave" value={s.chiave} />
      </form>

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

      <form action={risolviSegnalazioneAction} className="segnalazione-chiusura">
        <input type="hidden" name="chiave" value={s.chiave} />
        <textarea
          name="nota"
          className="dash-testo"
          rows={2}
          maxLength={1000}
          placeholder="Qual era il problema e come l'hai risolto (facoltativo)…"
          aria-label="Nota di chiusura"
        />
        <div className="dash-azioni">
          <button type="submit" className="btn-primary">
            ✓ Risolta
          </button>
          <button
            type="submit"
            form={rimetti}
            className="btn-mini"
            title="La recensione torna in «Da approvare» dell'operatore"
          >
            ↩ Rimetti in coda
          </button>
          <VediMail id={s.messaggioId} className="btn-mini" />
        </div>
      </form>
    </article>
  );
}
