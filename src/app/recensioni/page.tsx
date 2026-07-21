import Link from "next/link";
import { isGraphConfigured, searchMessages, type MailDetail } from "@/server/graph/client";
import {
  htmlToText,
  locationFromSubject,
  parseReview,
  splitTranslation,
  type ParsedReview,
} from "@/server/reviews/parse";
import { activeMailbox, loadSettings, type Label } from "@/server/settings";

export const dynamic = "force-dynamic";
export const metadata = { title: "Recensioni — Galdieri rent" };

const fmt = new Intl.DateTimeFormat("it-IT", { dateStyle: "medium", timeStyle: "short" });

type ReviewCard = {
  key: string;
  review: ParsedReview;
  location: string;
  receivedDateTime: string;
  source: MailDetail;
  threadCount: number;
  hasReply: boolean;
  resolved: boolean;
};

function Stars({ score }: { score: number | null }) {
  if (score === null) return <span className="muted">—</span>;
  return (
    <span className={`stars-badge stars-${score}`} title={`${score} su 5`}>
      {"★".repeat(score)}
      <span className="stars-empty">{"★".repeat(5 - score)}</span>
    </span>
  );
}

/** Raggruppa i messaggi per conversazione e ne ricava una recensione per flusso. */
function buildCards(messages: MailDetail[], label: Label): ReviewCard[] {
  const byConversation = new Map<string, MailDetail[]>();
  for (const m of messages) {
    const key = m.conversationId || m.id;
    const arr = byConversation.get(key);
    if (arr) arr.push(m);
    else byConversation.set(key, [m]);
  }

  const cards: ReviewCard[] = [];

  for (const [key, group] of byConversation) {
    // Il messaggio che contiene davvero i campi della recensione; si preferisce
    // l'originale di Zapier rispetto alle risposte che lo citano.
    let best: { msg: MailDetail; parsed: ParsedReview } | null = null;
    for (const m of group) {
      const parsed = parseReview(m.bodyIsHtml ? htmlToText(m.bodyContent) : m.bodyContent);
      if (!parsed) continue;
      const isZapier = m.fromAddress.toLowerCase().includes("zapier");
      if (!best || (isZapier && !best.msg.fromAddress.toLowerCase().includes("zapier"))) {
        best = { msg: m, parsed };
      }
    }
    if (!best) continue;

    const resolved = group.some((m) => /ticket\s+risolto/i.test(m.subject));
    const hasReply = group.some((m) => {
      const a = m.fromAddress.toLowerCase();
      return (
        a.endsWith("@galdierirent.it") && !a.startsWith("customer.care") && !a.includes("zapier")
      );
    });

    cards.push({
      key,
      review: best.parsed,
      location: locationFromSubject(best.msg.subject, label.subjectContains),
      receivedDateTime: best.msg.receivedDateTime,
      source: best.msg,
      threadCount: group.length,
      hasReply,
      resolved,
    });
  }

  return cards.sort(
    (a, b) => new Date(b.receivedDateTime).getTime() - new Date(a.receivedDateTime).getTime(),
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

  if (!isGraphConfigured() || !label) {
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

  let allCards: ReviewCard[] = [];
  let scanned = 0;
  let error: string | null = null;

  try {
    const messages = await searchMessages({
      subjectContains: label.subjectContains,
      fromContains: label.fromContains,
      top: 50,
      mailbox: await activeMailbox(),
    });
    scanned = messages.length;
    allCards = buildCards(messages, label);
  } catch (e) {
    error = e instanceof Error ? e.message : "Errore sconosciuto";
  }

  // I conteggi si calcolano SEMPRE su tutte le recensioni, anche quando è attivo
  // un filtro: così i cinque livelli restano sempre visibili.
  const counts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const c of allCards) {
    if (c.review.score && counts[c.review.score] !== undefined) counts[c.review.score] += 1;
  }

  const totale = allCards.length;
  const cards = selectedStars
    ? allCards.filter((c) => c.review.score === selectedStars)
    : allCards;

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
            const { translated, original } = splitTranslation(c.review.comment);
            return (
              <article key={c.key} className="review-card">
                <header className="review-head">
                  <div>
                    <div className="review-name">{c.review.name}</div>
                    <div className="review-sub muted">
                      {c.location && <span className="review-place">{c.location}</span>}
                      {fmt.format(new Date(c.receivedDateTime))}
                    </div>
                  </div>
                  <Stars score={c.review.score} />
                </header>

                {translated ? (
                  <p className="review-comment">{translated}</p>
                ) : (
                  <p className="review-comment muted">— nessun commento, solo punteggio —</p>
                )}

                {original && (
                  <details className="review-original">
                    <summary>Testo originale</summary>
                    <p>{original}</p>
                  </details>
                )}

                <footer className="review-foot">
                  {c.hasReply ? (
                    <span className="flag flag-green">risposta inviata</span>
                  ) : (
                    <span className="flag flag-amber">senza risposta</span>
                  )}
                  {c.resolved && <span className="flag flag-gray">ticket risolto</span>}
                  <span className="flag flag-gray">{c.threadCount} messaggi</span>
                  <Link className="btn-mini" href={`/email?id=${encodeURIComponent(c.source.id)}`}>
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
