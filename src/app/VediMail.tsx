"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

// Tasto "Vedi mail" della card: apre un POP-UP con l'email (non cambia pagina).
// Il contenuto si carica al primo click da /api/email/<id> e si mostra in un
// iframe sandbox (niente script dell'email). Si chiude con ✕, col click fuori
// o con Esc, e si torna esattamente dove si era.

type DatiMail = { subject: string; from: string; data: string; srcDoc: string };
type Stato = "idle" | "loading" | "ok" | "errore";

export function VediMail({ id, className }: { id: string; className?: string }) {
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
      <button type="button" className={className ?? "btn-mini"} onClick={apri}>
        Vedi mail
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
