import Link from "next/link";
import { getMessage, isGraphConfigured } from "@/server/graph/client";
import { setReadStateAction } from "../actions";

export const dynamic = "force-dynamic";

const fmt = new Intl.DateTimeFormat("it-IT", { dateStyle: "full", timeStyle: "short" });

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
      body { margin:0; padding:16px; font-family: "Segoe UI", system-ui, sans-serif;
             font-size:14px; line-height:1.55; color:#202124; background:#fff; }
      img, table { max-width:100%; height:auto; }
      pre { white-space:pre-wrap; word-wrap:break-word; font-family:inherit; }
      a { color:#1a73e8; }
    </style>`;
  const body = isHtml ? content : `<pre>${escapeHtml(content)}</pre>`;
  return `<!doctype html><html><head><meta charset="utf-8">${style}</head><body>${body}</body></html>`;
}

export default async function EmailPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  const { id } = await searchParams;

  if (!isGraphConfigured() || !id) {
    return (
      <main>
        <p>
          <Link href="/" className="btn-secondary">
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
    const mail = await getMessage(id);

    return (
      <main>
        <div className="mail-toolbar">
          <Link href="/" className="btn-secondary">
            ← Torna alla posta
          </Link>
          <form action={setReadStateAction}>
            <input type="hidden" name="id" value={mail.id} />
            <input type="hidden" name="isRead" value={mail.isRead ? "0" : "1"} />
            <button type="submit" className="btn-secondary">
              {mail.isRead ? "Segna come non letta" : "Segna come letta"}
            </button>
          </form>
          {mail.webLink && (
            <a
              className="btn-secondary"
              href={mail.webLink}
              target="_blank"
              rel="noopener noreferrer"
            >
              Apri in Outlook ↗
            </a>
          )}
        </div>

        <h1 className="mail-subject">{mail.subject}</h1>

        <section className="card mail-meta">
          <div className="mail-meta-row">
            <span className="mail-meta-label">Da</span>
            <span>
              {mail.fromName ? `${mail.fromName} — ` : ""}
              <span className="muted">{mail.fromAddress}</span>
            </span>
          </div>
          {mail.toRecipients.length > 0 && (
            <div className="mail-meta-row">
              <span className="mail-meta-label">A</span>
              <span className="muted">{mail.toRecipients.join(", ")}</span>
            </div>
          )}
          <div className="mail-meta-row">
            <span className="mail-meta-label">Ricevuta</span>
            <span>{fmt.format(new Date(mail.receivedDateTime))}</span>
          </div>
          <div className="mail-meta-row">
            <span className="mail-meta-label">Stato</span>
            <span>
              {mail.isRead ? (
                <span className="flag flag-gray">letta</span>
              ) : (
                <span className="flag flag-amber">non letta</span>
              )}
              {mail.hasAttachments && <span className="flag flag-gray"> allegato</span>}
            </span>
          </div>
        </section>

        <section className="card mail-body-card">
          <iframe
            className="mail-body"
            sandbox=""
            title="Contenuto dell'email"
            srcDoc={buildSrcDoc(mail.bodyContent, mail.bodyIsHtml)}
          />
        </section>
      </main>
    );
  } catch (e) {
    return (
      <main>
        <p>
          <Link href="/" className="btn-secondary">
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
