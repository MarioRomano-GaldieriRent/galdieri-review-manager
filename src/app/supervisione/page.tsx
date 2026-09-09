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
import { gestionePerStelle, modifichePerStelle, type Intervallo } from "@/server/statistiche/query";
import { BottoneTest } from "../BottoneTest";
import { Stelle } from "../da-pubblicare/Voci";
import { VediMail } from "../VediMail";
import { chiudiGiaGestitaAction, rimettiInCodaSegnalazioneAction } from "./actions";

// Supervisione: riservata all'amministratore. Due cose sole:
//   1. i numeri del periodo scelto (recensioni gestite per punteggio,
//      segnalazioni aperte/gestite, testi riscritti);
//   2. le recensioni che gli operatori hanno SEGNALATO perché non riuscivano a
//      gestirle, con la loro nota — da risolvere qui o rimandare in coda (questa
//      lista NON segue il periodo: è la coda di lavoro di ADESSO, non una
//      statistica storica).

export const dynamic = "force-dynamic";
export const metadata = { title: "Supervisione — GaldieriReviews" };

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
const PERIODO_DEFAULT = "30";

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

  const [righe, modifiche, apertePeriodo, gestitePeriodo, aperte, chiuse, utenti] = await Promise.all([
    gestionePerStelle(intervallo),
    modifichePerStelle(intervallo),
    contaApertePeriodo(dal, al),
    contaGestitePeriodo(dal, al),
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

  // Totali del periodo: la somma delle righe per stella, non una query a parte.
  const g = righe.reduce(
    (acc, r) => ({
      ricevute: acc.ricevute + r.ricevute,
      conRisposta: acc.conRisposta + r.conRisposta,
      dalSistema: acc.dalSistema + r.dalSistema,
    }),
    { ricevute: 0, conRisposta: 0, dalSistema: 0 },
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
          <Riquadro titolo="Gestite dal sistema" valore={g.dalSistema} base={perc(g.dalSistema)} />
          <Riquadro titolo="Gestite in totale" valore={g.conRisposta} base={perc(g.conRisposta)} />
          <Riquadro titolo="Recensioni ricevute" valore={g.ricevute} base={`ultimi ${periodoSel.etichetta}`} />
        </div>

        <h3 className="supervisione-sottotitolo">Segnalazioni nel periodo</h3>
        <div className="stat-griglia">
          <Riquadro titolo="Aperte" valore={apertePeriodo} base="passate all'amministratore" />
          <Riquadro titolo="Gestite" valore={gestitePeriodo} base="risolte o rimesse in coda" />
        </div>

        <h3 className="supervisione-sottotitolo">Per punteggio</h3>
        <div className="table-wrap">
          <table className="data-table data-table-compatta supervisione-stelle">
            <thead>
              <tr>
                <th>Punteggio</th>
                <th>Ricevute</th>
                <th>Gestite dal sistema</th>
                <th>Testi modificati</th>
              </tr>
            </thead>
            <tbody>
              {conPunteggio.map((r) => {
                const m = modifichePer.get(r.stelle);
                return (
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
                  <td className="muted">senza punteggio</td>
                  <td>{senzaPunteggio.ricevute}</td>
                  <td>{senzaPunteggio.dalSistema}</td>
                  <td>
                    {modSenzaPunteggio && modSenzaPunteggio.eseguiti > 0
                      ? `${modSenzaPunteggio.modificati} / ${modSenzaPunteggio.eseguiti}`
                      : "—"}
                  </td>
                </tr>
              )}
              <tr className="supervisione-totale">
                <td>Totale</td>
                <td>{g.ricevute}</td>
                <td>{g.dalSistema}</td>
                <td>
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

      {/* ------------------------------------------------ segnalazioni aperte */}
      <section className="card">
        <div className="sec-head">
          <h2>Segnalazioni aperte</h2>
          {aperte.length > 0 && <span className="chip-count">{aperte.length}</span>}
        </div>
        <p className="hint">
          Recensioni che un operatore ha passato a te col tasto «?» perché non riusciva a
          gestirle. Finché stanno qui, lui non le vede più.{" "}
          <strong>«Chiudi: già gestita»</strong> la chiude davvero — risulta gestita anche nelle
          statistiche e finisce in «Archiviate», dove resta leggibile col motivo e si può
          ripristinare: è il tasto per quando ti dicono «questa era già fatta».{" "}
          <strong>«Rimetti in coda»</strong> la fa ricomparire in «Da approvare» dell&apos;operatore.{" "}
          <strong>«Test»</strong> manda il robot a cercare QUELLA recensione su Google e ti riporta
          il passo-passo, senza pubblicare niente: è il modo per capire un «non lo trova» invece di
          indovinarlo.
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

      <form action={chiudiGiaGestitaAction} className="segnalazione-chiusura">
        <input type="hidden" name="chiave" value={s.chiave} />
        <textarea
          name="nota"
          className="dash-testo"
          rows={2}
          maxLength={1000}
          placeholder="Cos'era e perché la chiudi (finisce sotto la card in «Archiviate»)…"
          aria-label="Nota di chiusura"
        />
        <div className="dash-azioni">
          <button
            type="submit"
            className="btn-primary"
            title="La recensione risulta gestita e va in «Archiviate»: non torna né a te né all'operatore"
          >
            ✓ Chiudi: già gestita
          </button>
          <button
            type="submit"
            form={rimetti}
            className="btn-mini"
            title="La recensione torna in «Da approvare» dell'operatore"
          >
            ↩ Rimetti in coda
          </button>
          {/* Il perché di una segnalazione è quasi sempre «il robot non la
              trova»: il Test lo manda a cercarla e riporta il passo-passo, qui
              dove si decide, senza dover tornare in coda. Non pubblica nulla e
              l'azione ricontrolla da sé che chi la lancia sia admin. */}
          <BottoneTest chiave={s.chiave} />
          <VediMail id={s.messaggioId} className="btn-mini" />
        </div>
      </form>
    </article>
  );
}
