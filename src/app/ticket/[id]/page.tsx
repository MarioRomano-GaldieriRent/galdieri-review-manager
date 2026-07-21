import Link from "next/link";
import {
  getAgents,
  getConversations,
  getTicket,
  isFreshdeskConfigured,
  PRIORITA,
  STATO,
  ticketUrl,
} from "@/server/integrations/freshdesk";

export const dynamic = "force-dynamic";

const fmt = new Intl.DateTimeFormat("it-IT", { dateStyle: "medium", timeStyle: "short" });

// Il corpo dei messaggi è HTML proveniente dall'esterno: si mostra in un iframe
// con sandbox vuota, quindi senza esecuzione di script.
function srcDoc(html: string): string {
  const style = `<style>
    body{margin:0;padding:14px;font-family:"Segoe UI",system-ui,sans-serif;font-size:14px;
         line-height:1.55;color:#202124;background:#fff}
    img,table{max-width:100%;height:auto}
    blockquote{border-left:3px solid #dadce0;margin:8px 0;padding-left:12px;color:#5f6368}
    a{color:#1a73e8}
  </style>`;
  return `<!doctype html><html><head><meta charset="utf-8">${style}</head><body>${html}</body></html>`;
}

function statoClasse(status: number): string {
  if (status === 2) return "st-new";
  if (status === 3) return "st-needs_source_verification";
  if (status === 4 || status === 5) return "st-published";
  return "";
}

export default async function TicketDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const numero = Number(id);

  if (!(await isFreshdeskConfigured()) || !Number.isFinite(numero)) {
    return (
      <main>
        <p>
          <Link href="/ticket" className="btn-secondary">
            ← Torna ai ticket
          </Link>
        </p>
        <section className="card">
          <p className="form-error">Ticket non valido o Freshdesk non configurato.</p>
        </section>
      </main>
    );
  }

  try {
    // La conversazione si carica a parte: un suo errore non deve nascondere il
    // ticket, ma nemmeno essere scambiato per "nessun messaggio".
    let convErrore: string | null = null;
    const [ticket, esitoConv, agents, url] = await Promise.all([
      getTicket(numero),
      getConversations(numero).catch((e: unknown) => {
        convErrore = e instanceof Error ? e.message : "errore sconosciuto";
        return [];
      }),
      getAgents(),
      ticketUrl(numero),
    ]);
    const conversazioni = esitoConv;

    return (
      <main>
        <div className="mail-toolbar">
          <Link href="/ticket" className="btn-secondary">
            ← Torna ai ticket
          </Link>
          <span className="page-info">
            {convErrore
              ? "conversazione non caricata"
              : conversazioni.length === 0
                ? "solo richiesta iniziale"
                : `${conversazioni.length} messaggi nel ticket`}
          </span>
          <a className="btn-secondary" href={url} target="_blank" rel="noopener noreferrer">
            Apri in Freshdesk ↗
          </a>
        </div>

        <h1 className="mail-subject">
          <span className="muted">#{ticket.id}</span> {ticket.subject}
        </h1>

        <section className="card mail-meta">
          <div className="mail-meta-row">
            <span className="mail-meta-label">Stato</span>
            <span className="thread-actions">
              <span className={`status-badge ${statoClasse(ticket.status)}`}>
                {STATO[ticket.status] ?? ticket.status}
              </span>
              <span className="flag flag-gray">
                priorità {PRIORITA[ticket.priority] ?? ticket.priority}
              </span>
              {ticket.type && <span className="flag flag-gray">{ticket.type}</span>}
            </span>
          </div>
          <div className="mail-meta-row">
            <span className="mail-meta-label">Richiedente</span>
            <span>
              {ticket.requesterName || "—"}{" "}
              <span className="muted">{ticket.requesterEmail}</span>
            </span>
          </div>
          <div className="mail-meta-row">
            <span className="mail-meta-label">Assegnato a</span>
            <span>
              {ticket.responderId
                ? (agents.get(ticket.responderId) ?? `Agente ${ticket.responderId}`)
                : "nessuno"}
            </span>
          </div>
          {ticket.tags.length > 0 && (
            <div className="mail-meta-row">
              <span className="mail-meta-label">Tag</span>
              <span className="thread-actions">
                {ticket.tags.map((t) => (
                  <span key={t} className="flag flag-gray">
                    {t}
                  </span>
                ))}
              </span>
            </div>
          )}
          <div className="mail-meta-row">
            <span className="mail-meta-label">Creato</span>
            <span>{fmt.format(new Date(ticket.createdAt))}</span>
          </div>
          <div className="mail-meta-row">
            <span className="mail-meta-label">Aggiornato</span>
            <span>{fmt.format(new Date(ticket.updatedAt))}</span>
          </div>
        </section>

        {convErrore && (
          <section className="card">
            <p className="form-error">
              Non è stato possibile caricare i messaggi del ticket ({convErrore}). Qui sotto resta
              la richiesta iniziale.
            </p>
          </section>
        )}

        <section className="card thread">
          <details className="thread-item is-selected" open>
            <summary className="thread-summary">
              <span className="thread-from">Richiesta iniziale</span>
              <span className="thread-date">{fmt.format(new Date(ticket.createdAt))}</span>
              <span className="thread-preview">{ticket.requesterName || ticket.requesterEmail}</span>
            </summary>
            <div className="thread-body">
              <iframe
                className="mail-body"
                sandbox=""
                title="Descrizione del ticket"
                srcDoc={srcDoc(ticket.descriptionHtml)}
              />
            </div>
          </details>

          {conversazioni.map((c, i) => (
            <details key={c.id} className="thread-item" open={i === conversazioni.length - 1}>
              <summary className="thread-summary">
                <span className="thread-from">
                  {c.incoming ? "Cliente" : (c.userId && agents.get(c.userId)) || "Agente"}
                </span>
                <span className="thread-date">{fmt.format(new Date(c.createdAt))}</span>
                <span className="thread-preview">
                  {c.isPrivate ? "nota privata" : c.fromEmail || ""}
                </span>
              </summary>
              <div className="thread-body">
                {c.isPrivate && <p className="notice">Nota privata, non visibile al cliente.</p>}
                <iframe
                  className="mail-body"
                  sandbox=""
                  title={`Messaggio ${c.id}`}
                  srcDoc={srcDoc(c.bodyHtml)}
                />
              </div>
            </details>
          ))}
        </section>
      </main>
    );
  } catch (e) {
    return (
      <main>
        <p>
          <Link href="/ticket" className="btn-secondary">
            ← Torna ai ticket
          </Link>
        </p>
        <section className="card">
          <p className="form-error">
            Impossibile aprire il ticket: {e instanceof Error ? e.message : "errore sconosciuto"}
          </p>
        </section>
      </main>
    );
  }
}
