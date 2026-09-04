"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { suggerisciAction } from "./dashboard/suggerisci";

// Il box della risposta quando la proposta la scrive l'AI.
//
// La card è già visibile: se la proposta non è ancora stata generata, questo
// campo la chiede da solo mentre la pagina è a schermo, mostrando che sta
// lavorando. Appena arriva compare nel box (e resta salvata: al prossimo
// caricamento è immediata). Se l'AI non risponde, il box resta scrivibile a
// mano: non si blocca mai il lavoro.

type Props = {
  chiave: string;
  /** Proposta già salvata: se c'è, niente attesa. */
  iniziale: string | null;
  /** Testo di ripiego (quello della regola) se l'AI non è disponibile. */
  ripiego: string;
};

export function CampoRispostaAI({ chiave, iniziale, ripiego }: Props) {
  const [testo, setTesto] = useState(iniziale ?? "");
  const [errore, setErrore] = useState("");
  const [caricando, setCaricando] = useState(!iniziale);
  const [inCorso, avvia] = useTransition();
  // Una sola richiesta per card, anche con lo Strict Mode di sviluppo (che
  // monta i componenti due volte).
  const chiesto = useRef(false);

  useEffect(() => {
    if (iniziale || chiesto.current) return;
    chiesto.current = true;
    setCaricando(true);
    suggerisciAction(chiave)
      .then((e) => {
        if (e.ok) setTesto(e.testo);
        else {
          setErrore(e.errore);
          setTesto(ripiego);
        }
      })
      .catch((e: unknown) => {
        setErrore(e instanceof Error ? e.message : "errore");
        setTesto(ripiego);
      })
      .finally(() => setCaricando(false));
  }, [chiave, iniziale, ripiego]);

  function rigenera() {
    setErrore("");
    setCaricando(true);
    avvia(() => {
      suggerisciAction(chiave, { rigenera: true })
        .then((e) => {
          if (e.ok) setTesto(e.testo);
          else setErrore(e.errore);
        })
        .finally(() => setCaricando(false));
    });
  }

  const attesa = caricando || inCorso;

  return (
    <>
      <input type="hidden" name="testoOriginale" value={testo} />
      <div className="ai-testa">
        {attesa ? (
          <span className="ai-badge ai-badge-carica">
            <span className="ai-spinner" aria-hidden="true" />
            Sto scrivendo la proposta…
          </span>
        ) : errore ? (
          <span className="ai-badge ai-badge-ko" title={errore}>
            ⚠ Proposta non disponibile — scrivi tu la risposta
          </span>
        ) : (
          <span className="ai-badge">✨ Proposta AI — rileggila prima di pubblicare</span>
        )}
        <button
          type="button"
          className="btn-mini"
          onClick={rigenera}
          disabled={attesa}
          title="Chiedi un'altra proposta"
        >
          Rigenera
        </button>
      </div>
      <textarea
        name="testo"
        className="dash-testo"
        rows={testo.length > 120 ? 4 : 2}
        value={testo}
        onChange={(e) => setTesto(e.target.value)}
        placeholder={attesa ? "" : "Scrivi qui la risposta…"}
        aria-label="Testo della risposta"
        aria-busy={attesa}
      />
    </>
  );
}
