import Link from "next/link";
import {
  getAgents,
  isFreshdeskConfigured,
  listTickets,
  PRIORITA,
  searchTicketsByStatus,
  STATO,
  type FdTicket,
} from "@/server/integrations/freshdesk";

export const dynamic = "force-dynamic";
export const metadata = { title: "Ticket — Galdieri rent" };

const fmt = new Intl.DateTimeFormat("it-IT", { dateStyle: "short", timeStyle: "short" });
const PAGE_SIZE = 30;

type SearchParams = { stato?: string; q?: string; page?: string };

function statoClasse(status: number): string {
  if (status === 2) return "st-new";
  if (status === 3) return "st-needs_source_verification";
  if (status === 4 || status === 5) return "st-published";
  return "";
}

function buildQuery(p: Record<string, string | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v) sp.set(k, v);
  const s = sp.toString();
  return s ? `/ticket?${s}` : "/ticket";
}

export default async function TicketPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page ?? "1") || 1);
  const q = sp.q?.trim() ?? "";
  const statoNum = Number(sp.stato);
  const statoSel = [2, 3, 4, 5].includes(statoNum) ? statoNum : null;

  if (!(await isFreshdeskConfigured())) {
    return (
      <main>
        <h1>Ticket</h1>
        <section className="card">
          <p className="form-error">
            Freshdesk non è configurato. Vai in <Link href="/impostazioni">Impostazioni</Link> e
            inserisci dominio e API key.
          </p>
        </section>
      </main>
    );
  }

  let tickets: FdTicket[] = [];
  let total: number | null = null;
  let hasMore = false;
  let error: string | null = null;
  let agents = new Map<number, string>();

  try {
    if (statoSel) {
      const r = await searchTicketsByStatus(statoSel, page);
      tickets = r.tickets;
      total = r.total;
      hasMore = page * PAGE_SIZE < r.total;
    } else {
      const r = await listTickets({ page, perPage: PAGE_SIZE });
      tickets = r.tickets;
      hasMore = r.hasMore;
    }
    agents = await getAgents();
  } catch (e) {
    error = e instanceof Error ? e.message : "Errore sconosciuto";
  }

  // La ricerca testuale di Freshdesk non copre l'oggetto: si filtra la pagina caricata.
  const visibili = q
    ? tickets.filter(
        (t) =>
          t.subject.toLowerCase().includes(q.toLowerCase()) ||
          t.requesterName.toLowerCase().includes(q.toLowerCase()) ||
          t.requesterEmail.toLowerCase().includes(q.toLowerCase()) ||
          String(t.id).includes(q),
      )
    : tickets;

  return (
    <main>
      <h1>Ticket</h1>
      <p className="subtitle">
        Freshdesk — {statoSel ? `stato «${STATO[statoSel]}»` : "ultimi ticket"}
        {total !== null ? ` · ${total} totali` : ""}
        {q ? ` · filtro "${q}" nella pagina` : ""}
      </p>

      <p className="notice">
        <strong>Sola lettura.</strong> Questa sezione non crea, non modifica e non chiude nulla:
        tutte le richieste a Freshdesk sono di sola lettura.
      </p>

      <form className="card filters" method="get">
        <div className="filters-row">
          <label className="field grow">
            <span>Cerca nella pagina (oggetto, richiedente, numero)</span>
            <input name="q" defaultValue={q} placeholder="es. recensione, 56470…" />
          </label>
          {statoSel && <input type="hidden" name="stato" value={String(statoSel)} />}
          <div className="filters-actions">
            <button type="submit" className="btn-primary">
              Cerca
            </button>
            <Link href="/ticket" className="btn-secondary">
              Azzera
            </Link>
          </div>
        </div>
      </form>

      <div className="star-filter">
        <Link
          href={buildQuery({ q: q || undefined })}
          className={`star-chip chip-all${statoSel ? "" : " is-active"}`}
        >
          Tutti
        </Link>
        {[2, 3, 4, 5].map((s) => (
          <Link
            key={s}
            href={
              statoSel === s
                ? buildQuery({ q: q || undefined })
                : buildQuery({ stato: String(s), q: q || undefined })
            }
            className={`star-chip${statoSel === s ? " is-active" : ""}`}
          >
            {STATO[s]}
          </Link>
        ))}
      </div>

      {error && (
        <section className="card">
          <p className="form-error">Errore: {error}</p>
        </section>
      )}

      <section className="card">
        {visibili.length === 0 && !error ? (
          <p className="hint">Nessun ticket trovato.</p>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Oggetto</th>
                  <th>Richiedente</th>
                  <th>Stato</th>
                  <th>Priorità</th>
                  <th>Creato</th>
                </tr>
              </thead>
              <tbody>
                {visibili.map((t) => (
                  <tr key={t.id}>
                    <td className="nowrap muted">{t.id}</td>
                    <td className="review-cell">
                      <div className="review-author">
                        <Link href={`/ticket/${t.id}`}>{t.subject}</Link>
                      </div>
                      <div className="review-flags">
                        {/recension/i.test(t.subject) && (
                          <span className="flag flag-red">recensione</span>
                        )}
                        {t.type && <span className="flag flag-gray">{t.type}</span>}
                        {t.responderId && agents.get(t.responderId) && (
                          <span className="flag flag-gray">{agents.get(t.responderId)}</span>
                        )}
                      </div>
                    </td>
                    <td>
                      {t.requesterName || "—"}
                      <br />
                      <span className="muted">{t.requesterEmail}</span>
                    </td>
                    <td>
                      <span className={`status-badge ${statoClasse(t.status)}`}>
                        {STATO[t.status] ?? t.status}
                      </span>
                    </td>
                    <td className="nowrap">{PRIORITA[t.priority] ?? t.priority}</td>
                    <td className="nowrap">{fmt.format(new Date(t.createdAt))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="pagination">
        {page > 1 ? (
          <Link
            className="btn-secondary"
            href={buildQuery({
              stato: statoSel ? String(statoSel) : undefined,
              q: q || undefined,
              page: String(page - 1),
            })}
          >
            ← Precedente
          </Link>
        ) : (
          <span className="btn-secondary disabled">← Precedente</span>
        )}
        <span className="page-info">Pagina {page}</span>
        {hasMore ? (
          <Link
            className="btn-secondary"
            href={buildQuery({
              stato: statoSel ? String(statoSel) : undefined,
              q: q || undefined,
              page: String(page + 1),
            })}
          >
            Successiva →
          </Link>
        ) : (
          <span className="btn-secondary disabled">Successiva →</span>
        )}
      </div>
    </main>
  );
}
