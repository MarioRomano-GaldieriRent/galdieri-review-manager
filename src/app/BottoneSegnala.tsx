"use client";

import { useState } from "react";

// Il «?» rosso sulla card: l'operatore non riesce a gestire la recensione e la
// passa all'amministratore. Il tasto apre un campo per scrivere qual è il
// problema; campo e invio appartengono al form nascosto `segn-<chiave>` che
// sta sulla card (attributo form=), fuori dal form «Rispondi», che non si può
// annidare. Inviata, la recensione sparisce dalla coda ed entra in Supervisione.

export function BottoneSegnala({ chiave }: { chiave: string }) {
  const [aperto, setAperto] = useState(false);
  const form = `segn-${chiave}`;

  return (
    <>
      <button
        type="button"
        className={`btn-segnala${aperto ? " is-aperto" : ""}`}
        onClick={() => setAperto((v) => !v)}
        aria-expanded={aperto}
        aria-controls={`${form}-pannello`}
        aria-label="Segnala all'amministratore"
        title="Non riesci a gestirla? Segnalala all'amministratore: scrivi qual è il problema e passa a lui."
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
          <circle cx="12" cy="12" r="10" />
          <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" />
          <circle cx="12" cy="17" r="0.7" fill="currentColor" />
        </svg>
      </button>

      {aperto && (
        <div className="segnala-pannello" id={`${form}-pannello`}>
          <label className="segnala-etichetta" htmlFor={`${form}-nota`}>
            Qual è il problema?
          </label>
          <textarea
            id={`${form}-nota`}
            form={form}
            name="nota"
            className="dash-testo"
            rows={3}
            required
            maxLength={1000}
            autoFocus
            placeholder="Es. il cliente non si trova su Google, il ticket risulta già chiuso, la sede è sbagliata…"
          />
          <div className="segnala-azioni">
            <button type="submit" form={form} className="btn-primary">
              Segnala all'amministratore
            </button>
            <button type="button" className="btn-mini" onClick={() => setAperto(false)}>
              Annulla
            </button>
          </div>
          <p className="hint">
            La recensione sparisce dalla tua lista e passa a chi amministra, con la tua nota.
          </p>
        </div>
      )}
    </>
  );
}
