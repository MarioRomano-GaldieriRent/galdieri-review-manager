"use client";

import { useState } from "react";
import { SpiaBozza, useBozza } from "./useBozza";

// Il riquadro di risposta SENZA proposta AI: le 5★ senza commento, le 3★ e le
// card senza regola (occhio acceso). Unica differenza rispetto a prima: quello
// che si scrive si salva da solo, così un ricarico o l'auto-aggiornamento ogni
// tre minuti non lo buttano via.
//
// `testoOriginale` resta il testo della REGOLA, non quello che si sta
// scrivendo: è il confronto con cui playAction capisce se la risposta è stata
// riscritta a mano e va applicata a tutti i nodi (Google ed email).

export function CampoRisposta({
  chiave,
  iniziale,
  proposta,
  vuoto,
}: {
  chiave: string;
  /** Il testo da mostrare all'apertura: la bozza salvata, se c'è, altrimenti la proposta. */
  iniziale: string;
  /** Il testo della regola, per il confronto lato server. */
  proposta: string;
  /** true = card senza regola: il riquadro parte vuoto, con un invito. */
  vuoto?: boolean;
}) {
  const [testo, setTesto] = useState(iniziale);
  const stato = useBozza(chiave, testo, iniziale);

  return (
    <>
      <input type="hidden" name="testoOriginale" value={proposta} />
      <textarea
        name="testo"
        className="dash-testo"
        rows={testo.length > 120 ? 4 : 2}
        value={testo}
        onChange={(e) => setTesto(e.target.value)}
        placeholder={vuoto ? "Scrivi qui la risposta…" : undefined}
        aria-label="Testo della risposta"
      />
      <SpiaBozza stato={stato} />
    </>
  );
}
