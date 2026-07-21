import Link from "next/link";
import { isGraphConfigured, listInbox, WATCHED_MAILBOX } from "@/server/graph/client";
import { setReadStateAction } from "./actions";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;
const fmt = new Intl.DateTimeFormat("it-IT", { dateStyle: "short", timeStyle: "short" });

type SearchParams = { q?: string; page?: string; unread?: string };

function isReviewMail(subject: string): boolean {
  return /recension/i.test(subject);
}

function buildQuery(params: Record<string, string | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
  const s = sp.toString();
  return s ? `/?${s}` : "/";
}

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page ?? "1") || 1);
  const q = sp.q?.trim() || "";
  const unreadOnly = sp.unread === "1";

  if (!isGraphConfigured()) {
    return (
      <main>
        <h1>Posta in arrivo</h1>
        <section className="card">
          <p className="form-error">
            Microsoft Graph non è configurato. Controlla <code>MICROSOFT_CLIENT_ID</code>,{" "}
            <code>MICROSOFT_TENANT_ID</code>, <code>MICROSOFT_CLIENT_SECRET</code> e{" "}
            <code>MAIL_WATCH_ADDRESS</code> nel file <code>.env</code>.
          </p>
        </section>
      </main>
    );
  }

  let messages: Awaited<ReturnType<typeof listInbox>>["messages"] = [];
  let total: number | null = null;
  let error: string | null = null;

  try {
    const res = await listInbox({
      top: PAGE_SIZE,
      skip: q ? 0 : (page - 1) * PAGE_SIZE,
      search: q || undefined,
      unreadOnly,
    });
    messages = res.messages;
    total = res.total;
  } catch (e) {
    error = e instanceof Error ? e.message : "Errore sconosciuto";
  }

  const totalPages = total ? Math.max(1, Math.ceil(total / PAGE_SIZE)) : 1;

  return (
    <main>
      <h1>Posta in arrivo</h1>
      <p className="subtitle">
        Casella <strong>{WATCHED_MAILBOX}</strong>
        {total !== null && !q ? ` — ${total} email` : ""}
        {q ? ` — risultati per "${q}"` : ""}
        {unreadOnly ? " · solo non lette" : ""}
      </p>

      <form className="card filters" method="get">
        <div className="filters-row">
          <label className="field grow">
            <span>Cerca nelle email</span>
            <input name="q" defaultValue={q} placeholder="Oggetto, mittente, testo…" />
          </label>
          {unreadOnly && <input type="hidden" name="unread" value="1" />}
          <div className="filters-actions">
            <button type="submit" className="btn-primary">
              Cerca
            </button>
            <Link
              href={buildQuery({ q: q || undefined, unread: unreadOnly ? undefined : "1" })}
              className={unreadOnly ? "btn-secondary is-active" : "btn-secondary"}
            >
              {unreadOnly ? "✓ Solo non lette" : "Solo non lette"}
            </Link>
            <Link href="/" className="btn-secondary">
              Azzera
            </Link>
          </div>
        </div>
      </form>

      {error && (
        <section className="card">
          <p className="form-error">Errore nella lettura della casella: {error}</p>
        </section>
      )}

      <section className="card">
        {messages.length === 0 && !error ? (
          <p className="hint">
            {unreadOnly ? "Nessuna email non letta." : "Nessuna email trovata."}
          </p>
        ) : (
          <div className="table-wrap">
            <table className="data-table reviews-table">
              <thead>
                <tr>
                  <th>Ricevuta</th>
                  <th>Da</th>
                  <th>Oggetto</th>
                  <th>Stato</th>
                </tr>
              </thead>
              <tbody>
                {messages.map((m) => (
                  <tr key={m.id} className={m.isRead ? undefined : "unread"}>
                    <td className="nowrap">{fmt.format(new Date(m.receivedDateTime))}</td>
                    <td>
                      {m.fromName || m.fromAddress}
                      <br />
                      <span className="muted">{m.fromAddress}</span>
                    </td>
                    <td className="review-cell">
                      <div className="review-author">
                        {!m.isRead && <span className="unread-dot" aria-label="Non letta" />}
                        <Link href={`/email?id=${encodeURIComponent(m.id)}`}>{m.subject}</Link>
                      </div>
                      <div className="review-text">{m.preview.slice(0, 160)}</div>
                      <div className="review-flags">
                        {isReviewMail(m.subject) && (
                          <span className="flag flag-red">recensione</span>
                        )}
                        {m.hasAttachments && <span className="flag flag-gray">allegato</span>}
                      </div>
                    </td>
                    <td className="nowrap">
                      <form action={setReadStateAction}>
                        <input type="hidden" name="id" value={m.id} />
                        <input type="hidden" name="isRead" value={m.isRead ? "0" : "1"} />
                        <button type="submit" className="btn-mini">
                          {m.isRead ? "Segna non letta" : "Segna letta"}
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {!q && totalPages > 1 && (
        <div className="pagination">
          {page > 1 ? (
            <Link
              className="btn-secondary"
              href={buildQuery({
                q: q || undefined,
                unread: unreadOnly ? "1" : undefined,
                page: String(page - 1),
              })}
            >
              ← Precedente
            </Link>
          ) : (
            <span className="btn-secondary disabled">← Precedente</span>
          )}
          <span className="page-info">
            Pagina {page} di {totalPages}
          </span>
          {page < totalPages ? (
            <Link
              className="btn-secondary"
              href={buildQuery({
                q: q || undefined,
                unread: unreadOnly ? "1" : undefined,
                page: String(page + 1),
              })}
            >
              Successiva →
            </Link>
          ) : (
            <span className="btn-secondary disabled">Successiva →</span>
          )}
        </div>
      )}
    </main>
  );
}
