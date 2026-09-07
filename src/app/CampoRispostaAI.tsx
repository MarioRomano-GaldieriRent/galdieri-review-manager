"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { suggerisciAction } from "./dashboard/suggerisci";

// Il box della risposta quando la proposta la scrive l'AI.
//
// La card è già visibile: la proposta si chiede mentre la pagina è a schermo,
// mostrando che sta lavorando, e resta salvata (al prossimo caricamento è
// immediata). Se l'AI non risponde, il box resta scrivibile a mano.
//
// DUE freni, perché la coda può essere lunga (viste anche 91 recensioni
// insieme): la proposta si chiede solo quando la card entra davvero nello
// schermo, e non più di due per volta. Così scorrendo se ne generano poche
// alla volta, e per le recensioni che archivi senza arrivarci non si spende
// nulla.

/** Al massimo due richieste insieme, condivise da tutte le card della pagina. */
const MAX_INSIEME = 2;
let inCorso = 0;
const inCoda: (() => void)[] = [];

function prendiTurno(): Promise<void> {
  if (inCorso < MAX_INSIEME) {
    inCorso++;
    return Promise.resolve();
  }
  return new Promise((ok) => inCoda.push(ok));
}

function lasciaTurno(): void {
  const prossimo = inCoda.shift();
  // Il turno passa di mano: il contatore resta invariato se qualcuno aspettava.
  if (prossimo) prossimo();
  else inCorso = Math.max(0, inCorso - 1);
}

type Props = {
  chiave: string;
  /** Proposta già salvata: se c'è, niente attesa. */
  iniziale: string | null;
  /** Testo di ripiego (quello della regola) se l'AI non è disponibile. */
  ripiego: string;
};

type Stato = "pronto" | "daChiedere" | "carico" | "errore";

export function CampoRispostaAI({ chiave, iniziale, ripiego }: Props) {
  const [testo, setTesto] = useState(iniziale ?? "");
  const [errore, setErrore] = useState("");
  const [stato, setStato] = useState<Stato>(iniziale ? "pronto" : "daChiedere");
  // Una sola richiesta per card, anche con lo Strict Mode di sviluppo (che
  // monta i componenti due volte).
  const chiesto = useRef(Boolean(iniziale));
  const ancora = useRef<HTMLDivElement>(null);

  const genera = useCallback(
    async (rigenera: boolean) => {
      setErrore("");
      setStato("carico");
      await prendiTurno();
      try {
        const e = await suggerisciAction(chiave, rigenera ? { rigenera: true } : {});
        if (e.ok) {
          setTesto(e.testo);
          setStato("pronto");
        } else {
          setErrore(e.errore);
          setStato("errore");
          if (!rigenera) setTesto(ripiego);
        }
      } catch (e: unknown) {
        setErrore(e instanceof Error ? e.message : "errore");
        setStato("errore");
        if (!rigenera) setTesto(ripiego);
      } finally {
        lasciaTurno();
      }
    },
    [chiave, ripiego],
  );

  // Si chiede la proposta solo quando la card sta per entrare nello schermo.
  useEffect(() => {
    if (chiesto.current) return;
    const el = ancora.current;
    if (!el) return;
    // Senza IntersectionObserver (browser molto vecchi) si chiede subito.
    if (typeof IntersectionObserver === "undefined") {
      chiesto.current = true;
      void genera(false);
      return;
    }
    const osservatore = new IntersectionObserver(
      (voci) => {
        if (chiesto.current || !voci.some((v) => v.isIntersecting)) return;
        chiesto.current = true;
        osservatore.disconnect();
        void genera(false);
      },
      // Un po' di anticipo: quando la card arriva, la proposta è già pronta.
      { rootMargin: "400px 0px" },
    );
    osservatore.observe(el);
    return () => osservatore.disconnect();
  }, [genera]);

  const attesa = stato === "carico";

  return (
    <>
      <input type="hidden" name="testoOriginale" value={testo} />
      <div className="ai-testa" ref={ancora}>
        {attesa ? (
          <span className="ai-badge ai-badge-carica">
            <span className="ai-spinner" aria-hidden="true" />
            Sto scrivendo la proposta…
          </span>
        ) : stato === "errore" ? (
          <span className="ai-badge ai-badge-ko" title={errore}>
            ⚠ Proposta non disponibile — scrivi tu la risposta
          </span>
        ) : stato === "daChiedere" ? (
          <span className="ai-badge ai-badge-attesa">✨ Proposta AI</span>
        ) : (
          <span className="ai-badge">✨ Proposta AI — rileggila prima di pubblicare</span>
        )}
        <button
          type="button"
          className="btn-mini"
          onClick={() => {
            chiesto.current = true;
            void genera(stato === "pronto");
          }}
          disabled={attesa}
          title="Chiedi un'altra proposta"
        >
          {stato === "pronto" ? "Rigenera" : "Suggerisci"}
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
