import Link from "next/link";
import { isGraphConfigured } from "@/server/graph/client";
import { caricaRecensioni, type Recensione } from "@/server/reviews/load";
import { loadSettings } from "@/server/settings";
import { isTranslationConfigured } from "@/server/translate";

export const dynamic = "force-dynamic";
export const metadata = { title: "Recensioni — Galdieri rent" };

const fmt = new Intl.DateTimeFormat("it-IT", { dateStyle: "medium", timeStyle: "short" });

function Stars({ score }: { score: number | null }) {
  if (score === null) return <span className="muted">—</span>;
  return (
    <span className={`stars-badge stars-${score}`} title={`${score} su 5`}>
      {"★".repeat(score)}
      <span className="stars-empty">{"★".repeat(5 - score)}</span>
    </span>
  );
}

function href(labelId: string, stelle?: number): string {
  const p = new URLSearchParams({ label: labelId });
  if (stelle) p.set("stelle", String(stelle));
  return `/recensioni?${p}`;
}

export default async function RecensioniPage({
  searchParams,
}: {
  searchParams: Promise<{ label?: string; stelle?: string }>;
}) {
  const sp = await searchParams;
  const settings = await loadSettings();
  const label = settings.labels.find((l) => l.id === sp.label) ?? settings.labels[0] ?? null;

  const stelleNum = Number(sp.stelle);
  const selectedStars = stelleNum >= 1 && stelleNum <= 5 ? stelleNum : null;

  const graphPronto = await isGraphConfigured();
  const traduzioneAttiva = await isTranslationConfigured();

  if (!graphPronto || !label) {
    return (
      <main>
        <h1>Recensioni</h1>
        <section className="card">
          <p className="form-error">
            {!label
              ? "Nessuna etichetta configurata. Creane una in Impostazioni."
              : "Microsoft Graph non è configurato: controlla il file .env."}
          </p>
        </section>
      </main>
    );
  }

  let tutte: Recensione[] = [];
  let scanned = 0;
  let error: string | null = null;

  try {
    const esito = await caricaRecensioni(label);
    tutte = esito.recensioni;
    scanned = esito.analizzate;
  } catch (e) {
    error = e instanceof Error ? e.message : "Errore sconosciuto";
  }

  // I conteggi si calcolano SEMPRE su tutte le recensioni, anche quando è attivo
  // un filtro: così i cinque livelli restano sempre visibili.
  const counts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const c of tutte) {
    if (c.stelle && counts[c.stelle] !== undefined) counts[c.stelle] += 1;
  }

  const totale = tutte.length;
  const cards = selectedStars ? tutte.filter((c) => c.stelle === selectedStars) : tutte;

  return (
    <main>
      <h1>Recensioni</h1>
      <p className="subtitle">
        Etichetta <strong>{label.name}</strong> — {totale} recensioni da {scanned} email analizzate
        {selectedStars ? ` · filtro ${selectedStars}★` : ""}
      </p>

      {settings.labels.length > 1 && (
        <div className="label-tabs">
          {settings.labels.map((l) => (
            <Link
              key={l.id}
              href={href(l.id)}
              className={l.id === label.id ? "btn-secondary is-active" : "btn-secondary"}
            >
              {l.name}
            </Link>
          ))}
        </div>
      )}

      {error && (
        <section className="card">
          <p className="form-error">Errore nella lettura: {error}</p>
        </section>
      )}

      {!traduzioneAttiva && (
        <p className="notice">
          Traduzione in italiano non attiva: si vede il testo originale del cliente. Per attivarla
          imposta <code>AZURE_TRANSLATOR_KEY</code> e <code>AZURE_TRANSLATOR_REGION</code> nel file{" "}
          <code>.env</code>.
        </p>
      )}

      {totale > 0 && (
        <div className="star-filter">
          <Link
            href={href(label.id)}
            className={`star-chip chip-all${selectedStars ? "" : " is-active"}`}
          >
            Tutte <span className="chip-count">{totale}</span>
          </Link>

          {[1, 2, 3, 4, 5].map((n) => {
            const count = counts[n];
            const active = selectedStars === n;
            return (
              <Link
                key={n}
                href={active ? href(label.id) : href(label.id, n)}
                className={`star-chip s${n}${active ? " is-active" : ""}${count === 0 ? " is-empty" : ""}`}
                aria-label={`${count} recensioni da ${n} stelle`}
              >
                <span className="chip-stars">
                  {"★".repeat(n)}
                  <span className="stars-empty">{"★".repeat(5 - n)}</span>
                </span>
                <span className="chip-count">{count}</span>
              </Link>
            );
          })}
        </div>
      )}

      {cards.length === 0 && !error ? (
        <section className="card">
          <p className="hint">
            {selectedStars
              ? `Nessuna recensione da ${selectedStars} stelle.`
              : `Nessuna recensione trovata per l'etichetta «${label.name}».`}
          </p>
        </section>
      ) : (
        <div className="review-grid">
          {cards.map((c) => {
            // In evidenza sempre la versione italiana; sotto l'originale.
            const inItaliano = c.italiano ?? c.originale;
            const mostraOriginale = Boolean(
              c.originale && !c.giaItaliano && c.originale !== inItaliano,
            );
            return (
              <article key={c.chiave} className="review-card">
                <header className="review-head">
                  <div className="review-head-main">
                    <span className="review-name">{c.nome}</span>
                    {c.sede && <span className="review-place">{c.sede}</span>}
                    <span className="review-date">{fmt.format(new Date(c.ricevutaIl))}</span>
                  </div>
                  <Stars score={c.stelle} />
                </header>

                {inItaliano ? (
                  <p className="review-comment">{inItaliano}</p>
                ) : (
                  <p className="review-comment muted">— nessun commento, solo punteggio —</p>
                )}

                {mostraOriginale && (
                  <details className="review-original">
                    <summary>Testo originale{c.lingua ? ` (${c.lingua.toUpperCase()})` : ""}</summary>
                    <p>{c.originale}</p>
                  </details>
                )}

                {!c.italiano && c.ingleseDiGoogle && (
                  <details className="review-original">
                    <summary>Traduzione di Google (inglese)</summary>
                    <p>{c.ingleseDiGoogle}</p>
                  </details>
                )}

                <footer className="review-foot">
                  {c.haRisposta ? (
                    <span className="flag flag-green">risposta inviata</span>
                  ) : (
                    <span className="flag flag-amber">senza risposta</span>
                  )}
                  {c.risolto && <span className="flag flag-gray">ticket risolto</span>}
                  <span className="flag flag-gray">{c.numeroMessaggi} messaggi</span>
                  <Link className="btn-mini" href={`/email?id=${encodeURIComponent(c.messaggioId)}`}>
                    Vedi il flusso →
                  </Link>
                </footer>
              </article>
            );
          })}
        </div>
      )}
    </main>
  );
}
