"use client";

import { useId, useState } from "react";
import { segnalaAction } from "./supervisione/actions";

// Il «?» rosso sulla card: l'operatore non riesce a gestire la recensione e la
// passa all'amministratore, scrivendo qual è il problema.
//
// DEVE essere istantaneo: è un clic. Perciò l'azione si chiama direttamente da
// qui e NON naviga — prima si finiva con un redirect alla home, che è la pagina
// lenta (posta + Freshdesk), e il tasto sembrava piantato per decine di secondi.
// Anche la mail all'amministratore non si aspetta più: parte lato server dopo
// che la risposta è già arrivata al browser.
//
// Riuscita o no, la risposta si legge SUL POSTO: verde se è passata, rossa col
// motivo se no (per esempio quando era già stata segnalata). La card resta a
// schermo fino al prossimo caricamento della pagina: è un promemoria, non un
// errore — la segnalazione è già registrata.

type Stato = "chiuso" | "aperto" | "invio" | "fatta" | "errore";

export function BottoneSegnala({ chiave }: { chiave: string }) {
  const [stato, setStato] = useState<Stato>("chiuso");
  const [nota, setNota] = useState("");
  const [messaggio, setMessaggio] = useState("");
  const id = useId();

  const aperto = stato === "aperto" || stato === "invio" || stato === "errore";
  const inCorso = stato === "invio";

  async function invia() {
    if (!nota.trim() || inCorso) return;
    setStato("invio");
    try {
      const esito = await segnalaAction(chiave, nota);
      if (esito.ok) {
        setStato("fatta");
        setMessaggio(esito.messaggio);
      } else {
        setStato("errore");
        setMessaggio(esito.errore);
      }
    } catch (e) {
      setStato("errore");
      setMessaggio(e instanceof Error ? e.message : "Non è riuscita: riprova.");
    }
  }

  // Andata a buon fine: al posto del pannello resta la conferma, e il «?»
  // diventa una spunta spenta — non si segnala due volte la stessa cosa.
  if (stato === "fatta") {
    return (
      <span className="segnala-fatta" role="status">
        ✓ {messaggio || "Passata all'amministratore."}
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        className={`btn-segnala${aperto ? " is-aperto" : ""}`}
        onClick={() => setStato((s) => (s === "chiuso" ? "aperto" : "chiuso"))}
        aria-expanded={aperto}
        aria-controls={`${id}-pannello`}
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
        <div className="segnala-pannello" id={`${id}-pannello`}>
          <label className="segnala-etichetta" htmlFor={`${id}-nota`}>
            Qual è il problema?
          </label>
          <textarea
            id={`${id}-nota`}
            className="dash-testo"
            rows={3}
            maxLength={1000}
            autoFocus
            value={nota}
            onChange={(e) => setNota(e.target.value)}
            disabled={inCorso}
            placeholder="Es. il cliente non si trova su Google, il ticket risulta già chiuso, la sede è sbagliata…"
          />
          <div className="segnala-azioni">
            <button
              type="button"
              className="btn-primary"
              onClick={invia}
              disabled={inCorso || !nota.trim()}
              aria-busy={inCorso}
            >
              {inCorso ? (
                <span className="btn-caricamento">
                  <span className="spinner-mini spinner-chiaro" aria-hidden="true" />
                  Invio…
                </span>
              ) : (
                "Segnala all'amministratore"
              )}
            </button>
            {!inCorso && (
              <button type="button" className="btn-mini" onClick={() => setStato("chiuso")}>
                Annulla
              </button>
            )}
          </div>
          {stato === "errore" ? (
            <p className="form-error segnala-esito">{messaggio}</p>
          ) : (
            <p className="hint">
              Passa a chi amministra con la tua nota, e sparisce dalla tua lista al prossimo
              caricamento.
            </p>
          )}
        </div>
      )}
    </>
  );
}
