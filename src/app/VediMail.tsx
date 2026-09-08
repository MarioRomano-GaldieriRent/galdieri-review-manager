"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

// Tasto "Vedi mail" della card: apre un POP-UP con l'email (non cambia pagina).
// Il contenuto si carica al primo click da /api/email/<id> e si mostra in un
// iframe sandbox (niente script dell'email). Si chiude con ✕, col click fuori
// o con Esc, e si torna esattamente dove si era.

type DatiMail = { subject: string; from: string; data: string; srcDoc: string };
type Stato = "idle" | "loading" | "ok" | "errore";

/** La letterina: stessa forma della busta, per il tasto tondo (variante `icona`). */
function IconaLetterina() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m22 6-10 7L2 6" />
    </svg>
  );
}

/**
 * `icona`: variante tonda a sola icona (stesso stile dell'occhio dell'anteprima
 * — sfondo bianco, bordo, 40×40), senza testo. Il tasto testuale resta il
 * default per i contesti senza quella riga di icone (es. «In attesa»).
 */
export function VediMail({
  id,
  className,
  icona,
}: {
  id: string;
  className?: string;
  icona?: boolean;
}) {
  const [aperto, setAperto] = useState(false);
  const [stato, setStato] = useState<Stato>("idle");
  const [dati, setDati] = useState<DatiMail | null>(null);
  const [errore, setErrore] = useState("");

  const chiudi = useCallback(() => setAperto(false), []);

  async function apri() {
    setAperto(true);
    if (stato === "ok" || stato === "loading") return;
    setStato("loading");
    try {
      const r = await fetch(`/api/email/${encodeURIComponent(id)}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j?.errore || `Errore ${r.status}`);
      setDati(j as DatiMail);
      setStato("ok");
    } catch (e) {
      setErrore(e instanceof Error ? e.message : "Errore sconosciuto");
      setStato("errore");
    }
  }

  useEffect(() => {
    if (!aperto) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") chiudi();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [aperto, chiudi]);

  return (
    <>
      <button
        type="button"
        className={icona ? "btn-occhio" : (className ?? "btn-mini")}
        onClick={apri}
        title={icona ? "Vedi mail" : undefined}
        aria-label={icona ? "Vedi mail" : undefined}
      >
        {icona ? <IconaLetterina /> : "Vedi mail"}
      </button>

      {aperto &&
        createPortal(
          <div className="modal-overlay" onClick={chiudi} role="presentation">
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Email"
          >
            <div className="modal-testa">
              <strong className="modal-oggetto">{dati?.subject ?? "Email"}</strong>
              <button type="button" className="modal-chiudi" onClick={chiudi} aria-label="Chiudi">
                ✕
              </button>
            </div>

            {stato === "loading" && <p className="modal-info">Carico l&apos;email…</p>}
            {stato === "errore" && (
              <p className="modal-info modal-info-ko">Impossibile caricare l&apos;email: {errore}</p>
            )}
            {stato === "ok" && dati && (
              <>
                <div className="modal-meta">
                  {dati.from} · {dati.data}
                </div>
                <iframe
                  className="modal-mail"
                  sandbox=""
                  title={`Email: ${dati.subject}`}
                  srcDoc={dati.srcDoc}
                />
              </>
            )}
          </div>
        </div>,
          document.body,
        )}
    </>
  );
}
