"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

// Tasto "occhio" sulla card: apre un pop-up che mostra, passo per passo, cosa
// verrà eseguito su QUESTA recensione (email, Freshdesk, Google), con icona e
// colore per servizio. I passaggi sono già renderizzati dal server e passati
// come children: l'anteprima è dinamica (dipende dalla regola che copre la
// recensione), il pop-up si limita a mostrarli.

export function AnteprimaFlusso({
  titolo,
  children,
}: {
  titolo: string;
  children: React.ReactNode;
}) {
  const [aperto, setAperto] = useState(false);
  const chiudi = useCallback(() => setAperto(false), []);

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
        className="btn-occhio"
        onClick={() => setAperto(true)}
        title="Anteprima: cosa verrà eseguito"
        aria-label="Anteprima del flusso"
      >
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
          <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </button>

      {aperto &&
        createPortal(
          <div className="modal-overlay" onClick={chiudi} role="presentation">
            <div
              className="modal modal-flusso"
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-modal="true"
              aria-label={titolo}
            >
              <div className="modal-testa">
                <strong className="modal-oggetto">{titolo}</strong>
                <button type="button" className="modal-chiudi" onClick={chiudi} aria-label="Chiudi">
                  ✕
                </button>
              </div>
              <div className="modal-corpo">{children}</div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
