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
    // Risposta scritta da una persona interna (non Zapier, non il bot dei ticket)
    const hasReply = group.some((m) => {
      const a = m.fromAddress.toLowerCase();
      return (
        a.endsWith("@galdierirent.it") &&
        !a.startsWith("customer.care") &&
        !a.includes("zapier")
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
    (a, b) =>
      new Date(b.receivedDateTime).getTime() - new Date(a.receivedDateTime).getTime(),
  );
}

export default async function RecensioniPage({
  searchParams,
}: {
  searchParams: Promise<{ label?: string }>;
}) {
  const sp = await searchParams;
  const settings = await loadSettings();
  const label =
    settings.labels.find((l) => l.id === sp.label) ?? settings.labels[0] ?? null;

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

  let cards: ReviewCard[] = [];
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
    cards = buildCards(messages, label);
  } catch (e) {
    error = e instanceof Error ? e.message : "Errore sconosciuto";
  }

  const withScore = cards.filter((c) => c.review.score !== null);
  const media =
    withScore.length > 0
      ? (withScore.reduce((s, c) => s + (c.review.score ?? 0), 0) / withScore.length).toFixed(1)
      : "—";

  return (
    <main>
      <h1>Recensioni</h1>
      <p className="subtitle">
        Etichetta <strong>{label.name}</strong> — {cards.length} recensioni da {scanned} email
        analizzate
      </p>

      {settings.labels.length > 1 && (
        <div className="label-tabs">
          {settings.labels.map((l) => (
            <Link
              key={l.id}
              href={`/recensioni?label=${encodeURIComponent(l.id)}`}
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

      {cards.length > 0 && (
        <section className="card">
          <div className="stats-row">
            <div className="stat-box">
              <span className="stat-value">{cards.length}</span>
              <span className="stat-name">recensioni</span>
            </div>
            <div className="stat-box">
              <span className="stat-value">{media}</span>
              <span className="stat-name">media</span>
            </div>
            <div className="stat-box">
              <span className="stat-value">{cards.filter((c) => c.hasReply).length}</span>
              <span className="stat-name">con risposta</span>
            </div>
            <div className="stat-box">
              <span className="stat-value">
                {cards.filter((c) => (c.review.score ?? 5) <= 3).length}
              </span>
              <span className="stat-name">critiche (≤3★)</span>
            </div>
          </div>
        </section>
      )}

      {cards.length === 0 && !error ? (
        <section className="card">
          <p className="hint">
            Nessuna recensione trovata per l&apos;etichetta «{label.name}» (oggetto contenente «
            {label.subjectContains}»
            {label.fromContains ? `, mittente contenente «${label.fromContains}»` : ""}).
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
                  <Link
                    className="btn-mini"
                    href={`/email?id=${encodeURIComponent(c.source.id)}`}
                  >
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
