import Link from "next/link";
import {
  getConversation,
  getMessage,
  isGraphConfigured,
  type MailDetail,
  type Recipient,
} from "@/server/graph/client";
import { activeMailbox } from "@/server/settings";
import { setReadStateAction } from "../actions";

export const dynamic = "force-dynamic";

const fmtLong = new Intl.DateTimeFormat("it-IT", { dateStyle: "full", timeStyle: "short" });
const fmtShort = new Intl.DateTimeFormat("it-IT", { dateStyle: "short", timeStyle: "short" });

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Il corpo viene mostrato in un iframe con sandbox vuota: niente script, niente form.
function buildSrcDoc(content: string, isHtml: boolean): string {
  const style = `
    <style>
      body { margin:0; padding:16px; font-family:"Segoe UI",system-ui,sans-serif;
             font-size:14px; line-height:1.55; color:#202124; background:#fff; }
      img, table { max-width:100%; height:auto; }
      pre { white-space:pre-wrap; word-wrap:break-word; font-family:inherit; }
      a { color:#1a73e8; }
    </style>`;
  const body = isHtml ? content : `<pre>${escapeHtml(content)}</pre>`;
  return `<!doctype html><html><head><meta charset="utf-8">${style}</head><body>${body}</body></html>`;
}

/**
 * Titolo della conversazione: si parte dall'oggetto del messaggio più vecchio e si
 * tolgono i prefissi di risposta/inoltro e quelli del ticketing ("Ticket Creato - ").
 */
function threadSubject(s: string): string {
  const cleaned = s
    .replace(/^\s*ticket\s+(creato|risolto|aggiornato|chiuso)\s*[-–:]\s*/i, "")
    .replace(/^((r|re|i|fw|fwd|rif)\s*:\s*)+/i, "")
    .trim();
  return cleaned || s;
}

function RecipientList({ label, people }: { label: string; people: Recipient[] }) {
  if (people.length === 0) return null;
  return (
    <div className="mail-meta-row">
      <span className="mail-meta-label">{label}</span>
      <span className="muted">
        {people.map((p) => (p.name ? `${p.name} <${p.address}>` : p.address)).join(", ")}
      </span>
    </div>
  );
}

function MessageBlock({ mail, isSelected }: { mail: MailDetail; isSelected: boolean }) {
  return (
    <details className={`thread-item${isSelected ? " is-selected" : ""}`} open={isSelected}>
      <summary className="thread-summary">
        <span className="thread-from">
          {!mail.isRead && <span className="unread-dot" aria-label="Non letta" />}
          {mail.fromName || mail.fromAddress}
        </span>
        <span className="thread-date">{fmtShort.format(new Date(mail.receivedDateTime))}</span>
        <span className="thread-preview">{mail.preview.slice(0, 90)}</span>
      </summary>

      <div className="thread-body">
        <div className="mail-meta">
          <div className="mail-meta-row">
            <span className="mail-meta-label">Da</span>
            <span>
              {mail.fromName ? `${mail.fromName} ` : ""}
              <span className="muted">&lt;{mail.fromAddress}&gt;</span>
            </span>
          </div>
          <RecipientList label="A" people={mail.toRecipients} />
          <RecipientList label="CC" people={mail.ccRecipients} />
          <div className="mail-meta-row">
            <span className="mail-meta-label">Data</span>
            <span>{fmtLong.format(new Date(mail.receivedDateTime))}</span>
          </div>
          <div className="mail-meta-row">
            <span className="mail-meta-label">Stato</span>
            <span className="thread-actions">
              {mail.isRead ? (
                <span className="flag flag-gray">letta</span>
              ) : (
                <span className="flag flag-amber">non letta</span>
              )}
              {mail.hasAttachments && <span className="flag flag-gray">allegato</span>}
              <form action={setReadStateAction}>
                <input type="hidden" name="id" value={mail.id} />
                <input type="hidden" name="isRead" value={mail.isRead ? "0" : "1"} />
                <button type="submit" className="btn-mini">
                  {mail.isRead ? "Segna non letta" : "Segna letta"}
                </button>
              </form>
              {mail.webLink && (
                <a
                  className="btn-mini"
                  href={mail.webLink}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Outlook ↗
                </a>
              )}
            </span>
          </div>
        </div>

        <iframe
          className="mail-body"
          sandbox=""
          title={`Contenuto: ${mail.subject}`}
          srcDoc={buildSrcDoc(mail.bodyContent, mail.bodyIsHtml)}
        />
      </div>
    </details>
  );
}

export default async function EmailPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  const { id } = await searchParams;

  if (!(await isGraphConfigured()) || !id) {
    return (
      <main>
        <p>
          <Link href="/posta" className="btn-secondary">
            ← Torna alla posta
          </Link>
        </p>
        <section className="card">
          <p className="form-error">Messaggio non specificato o configurazione mancante.</p>
        </section>
      </main>
    );
  }

  try {
    const mailbox = await activeMailbox();
    const selected = await getMessage(id, mailbox);

    // Recupera l'intero flusso; se non riesce, mostra almeno il messaggio aperto.
    let thread: MailDetail[] = [];
    let threadError: string | null = null;
    try {
      thread = await getConversation(selected.conversationId, mailbox);
    } catch (e) {
      threadError = e instanceof Error ? e.message : "errore sconosciuto";
    }
    if (thread.length === 0) thread = [selected];

    return (
      <main>
        <div className="mail-toolbar">
          <Link href="/posta" className="btn-secondary">
            ← Torna alla posta
          </Link>
          <span className="page-info">
            {thread.length === 1 ? "1 messaggio" : `${thread.length} messaggi nella conversazione`}
          </span>
        </div>

        <h1 className="mail-subject">{threadSubject(thread[0].subject)}</h1>

        {threadError && (
          <section className="card">
            <p className="form-error">
              Non è stato possibile caricare l&apos;intera conversazione ({threadError}). Mostro
              solo il messaggio selezionato.
            </p>
          </section>
        )}

        <section className="card thread">
          {thread.map((m) => (
            <MessageBlock key={m.id} mail={m} isSelected={m.id === selected.id} />
          ))}
        </section>
      </main>
    );
  } catch (e) {
    return (
      <main>
        <p>
          <Link href="/posta" className="btn-secondary">
            ← Torna alla posta
          </Link>
        </p>
        <section className="card">
          <p className="form-error">
            Impossibile aprire il messaggio: {e instanceof Error ? e.message : "errore sconosciuto"}
          </p>
        </section>
      </main>
    );
  }
}
