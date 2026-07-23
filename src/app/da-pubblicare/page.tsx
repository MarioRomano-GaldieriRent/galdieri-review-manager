import Link from "next/link";
import {
  codaDaPubblicare,
  conteggiPubblicazione,
  linkGoogle,
  type VocePubblicazione,
} from "@/server/db/pubblicazioni";
import { ritentaChiusureInSospeso } from "@/server/pubblicazione";
import { isFreshdeskConfigured } from "@/server/integrations/freshdesk";
import { loadSettings } from "@/server/settings";
import { CopiaRisposta } from "./CopiaRisposta";
import { segnaPubblicataAction } from "./actions";

// Coda "Da pubblicare": le risposte approvate, da incollare a mano su Google
// finché l'API non è attiva. Per ogni riga tre controlli: apri su Google,
// copia la risposta, segna come pubblicata. Resta come fallback anche dopo.

export const dynamic = "force-dynamic";
export const metadata = { title: "Da pubblicare — Galdieri rent" };

function Stelle({ n }: { n: number | null }) {
  const v = n ?? 0;
  return (
    <span className={`stars-badge stars-${v}`} title={n ? `${n} su 5` : "senza punteggio"}>
      {"★".repeat(v)}
      <span className="stars-empty">{"★".repeat(5 - v)}</span>
    </span>
  );
}

function href(p: { sede?: string; stelle?: number | null }): string {
  const q = new URLSearchParams();
  if (p.sede) q.set("sede", p.sede);
  if (p.stelle) q.set("stelle", String(p.stelle));
  const s = q.toString();
  return s ? `/da-pubblicare?${s}` : "/da-pubblicare";
}

export default async function DaPubblicarePage({
  searchParams,
}: {
  searchParams: Promise<{ sede?: string; stelle?: string }>;
}) {
  const sp = await searchParams;

  // All'apertura si ritentano, best-effort, le chiusure Freshdesk in sospeso.
  await ritentaChiusureInSospeso();

  const [tutta, conteggi, fdOk, settings] = await Promise.all([
    codaDaPubblicare(),
    conteggiPubblicazione(),
    isFreshdeskConfigured(),
    loadSettings(),
  ]);
  const simulazione = settings.modo !== "reale";

  // Opzioni sede e conteggi per stella calcolati sull'intera coda, così i
  // filtri restano stabili anche quando sono attivi.
  const sedi = [...new Set(tutta.map((v) => v.sedeNome).filter(Boolean))].sort();
  const perStelle: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const v of tutta)
    if (v.stelle && perStelle[v.stelle] !== undefined) perStelle[v.stelle] += 1;

  const stelleNum = Number(sp.stelle);
  const stelleSel = stelleNum >= 1 && stelleNum <= 5 ? stelleNum : null;
  const sedeSel = sp.sede && sedi.includes(sp.sede) ? sp.sede : null;

  const voci = tutta.filter(
    (v) => (!stelleSel || v.stelle === stelleSel) && (!sedeSel || v.sedeNome === sedeSel),
  );

  return (
    <main>
      <header className="dash-testa">
        <div>
          <h1>Da pubblicare</h1>
          <p className="subtitle">
            {voci.length} risposte pronte da incollare su Google
            {conteggi.daRicontrollare > 0 ? ` · ${conteggi.daRicontrollare} da ricontrollare` : ""}
            {stelleSel ? ` · ${stelleSel}★` : ""}
            {sedeSel ? ` · ${sedeSel}` : ""}
          </p>
        </div>
        <div className="dash-stato-servizi">
          <span className={`conn-badge ${fdOk ? "conn-ok" : "conn-ko"}`}>
            {fdOk ? "Freshdesk collegato" : "Freshdesk da configurare"}
          </span>
        </div>
      </header>

      <section className={`card modo-riga ${simulazione ? "modo-sim" : "modo-reale"}`}>
        <span className={`conn-badge ${simulazione ? "conn-ok" : "conn-ko"}`}>
          {simulazione ? "simulazione" : "MODALITÀ REALE"}
        </span>
        <span className="modo-riga-testo">
          {simulazione
            ? "«Segna come pubblicata» sposta la risposta nel ricontrollo, ma il ticket NON viene chiuso su Freshdesk."
            : "«Segna come pubblicata» chiude anche il ticket collegato su Freshdesk."}
        </span>
        <Link href="/impostazioni#modo" className="btn-secondary">
          Modalità →
        </Link>
      </section>

      {/* --------------------------------------------------------- filtri */}
      {tutta.length > 0 && (
        <div className="pub-filtri">
          <div className="star-filter">
            <Link
              href={href({ sede: sedeSel ?? undefined })}
              className={`star-chip chip-all${stelleSel ? "" : " is-active"}`}
            >
              Tutte <span className="chip-count">{tutta.length}</span>
            </Link>
            {[5, 4, 3, 2, 1].map((n) => {
              const attivo = stelleSel === n;
              return (
                <Link
                  key={n}
                  href={href({ sede: sedeSel ?? undefined, stelle: attivo ? null : n })}
                  className={`star-chip s${n}${attivo ? " is-active" : ""}${perStelle[n] === 0 ? " is-empty" : ""}`}
                >
                  <span className="chip-stars">
                    {"★".repeat(n)}
                    <span className="stars-empty">{"★".repeat(5 - n)}</span>
                  </span>
                  <span className="chip-count">{perStelle[n]}</span>
                </Link>
              );
            })}
          </div>

          {sedi.length > 1 && (
            <div className="pub-sedi">
              <Link
                href={href({ stelle: stelleSel })}
                className={`btn-mini${sedeSel ? "" : " is-active"}`}
              >
                Tutte le sedi
              </Link>
              {sedi.map((s) => (
                <Link
                  key={s}
                  href={href({ sede: sedeSel === s ? undefined : s, stelle: stelleSel })}
                  className={`btn-mini${sedeSel === s ? " is-active" : ""}`}
                >
                  {s}
                </Link>
              ))}
            </div>
          )}
        </div>
      )}

      {/* --------------------------------------------------------- elenco */}
      {voci.length === 0 ? (
        <section className="card dash-vuoto">
          {tutta.length === 0
            ? "Nessuna risposta in attesa di pubblicazione. Le risposte approvate dalla dashboard compaiono qui."
            : "Nessuna risposta con questi filtri."}
        </section>
      ) : (
        <ol className="pub-lista">
          {voci.map((v, i) => (
            <VoceCoda key={v.chiave} v={v} numero={i + 1} sedeSel={sedeSel} stelleSel={stelleSel} />
          ))}
        </ol>
      )}
    </main>
  );
}

function VoceCoda({
  v,
  numero,
  sedeSel,
  stelleSel,
}: {
  v: VocePubblicazione;
  numero: number;
  sedeSel: string | null;
  stelleSel: number | null;
}) {
  const link = linkGoogle(v);
  return (
    <li className="card pub-card">
      <div className="pub-testa">
        <span className="pub-numero" aria-hidden="true">
          {numero}
        </span>
        <div className="pub-autore">
          <span className="review-name">{v.nomeCliente}</span>
          <span className="dash-fonte">{v.origine === "google" ? "Google" : "Trustpilot"}</span>
          {v.sedeNome && <span className="dash-lingua">{v.sedeNome}</span>}
          {v.ripubblicazioni > 0 && (
            <span className="flag flag-amber">ripubblicazione #{v.ripubblicazioni}</span>
          )}
        </div>
        <Stelle n={v.stelle} />
      </div>

      {v.testoRecensione && <p className="pub-recensione">«{v.testoRecensione}»</p>}

      <div className="pub-risposta">
        <span className="pub-etichetta">Risposta da pubblicare</span>
        <p className="pub-risposta-testo">{v.testoRisposta}</p>
      </div>

      <div className="pub-controlli">
        <a className="btn-secondary" href={link.url} target="_blank" rel="noopener noreferrer">
          Apri su Google ↗
        </a>
        <CopiaRisposta testo={v.testoRisposta} />
        <form action={segnaPubblicataAction} data-segna>
          <input type="hidden" name="chiave" value={v.chiave} />
          <input type="hidden" name="sede" value={sedeSel ?? ""} />
          <input type="hidden" name="stelle" value={stelleSel ?? ""} />
          <button type="submit" className="btn-primary">
            Segna come pubblicata
          </button>
        </form>
      </div>

      {link.generico && (
        <p className="hint pub-link-generico">
          Nessun link diretto per questa sede: si apre la gestione recensioni generica, cerca «
          {v.sedeNome || "la sede"}». Puoi impostare il link diretto nella pagina Sedi.
        </p>
      )}
    </li>
  );
}
