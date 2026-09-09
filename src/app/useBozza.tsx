"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { salvaBozzaAction } from "./dashboard/bozza";

// Il salvataggio automatico del riquadro di risposta, condiviso dai due campi
// (quello semplice e quello con la proposta AI).
//
// Si salva a RAFFICHE DIRADATE: un secondo dopo l'ultimo tasto premuto, non a
// ogni carattere. E si salva anche quando la scheda passa in secondo piano o si
// chiude, perché è lì che si perde il lavoro: chi chiude il portatile a metà
// frase non deve ritrovare il riquadro com'era prima.
//
// Il primo valore NON si salva: altrimenti il solo aprire la pagina scriverebbe
// una bozza identica alla proposta della regola per ogni card in elenco.

const ATTESA_MS = 1000;

export type StatoBozza = "fermo" | "scrivo" | "salvata" | "errore";

export function useBozza(chiave: string, testo: string, iniziale: string) {
  const [stato, setStato] = useState<StatoBozza>("fermo");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** L'ultimo testo davvero salvato: evita di riscrivere lo stesso valore. */
  const salvato = useRef(iniziale);
  /** Il testo corrente, per il salvataggio d'emergenza all'uscita. */
  const corrente = useRef(testo);
  corrente.current = testo;

  const salva = useCallback(
    async (valore: string) => {
      if (valore === salvato.current) return;
      salvato.current = valore;
      const esito = await salvaBozzaAction(chiave, valore);
      setStato(esito.ok ? "salvata" : "errore");
    },
    [chiave],
  );

  useEffect(() => {
    if (testo === salvato.current) return;
    setStato("scrivo");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void salva(testo), ATTESA_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [testo, salva]);

  // Scheda nascosta o pagina che si chiude: si salva subito, senza aspettare.
  useEffect(() => {
    const subito = () => {
      if (corrente.current !== salvato.current) void salva(corrente.current);
    };
    const onVisibilita = () => {
      if (document.visibilityState === "hidden") subito();
    };
    document.addEventListener("visibilitychange", onVisibilita);
    window.addEventListener("pagehide", subito);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilita);
      window.removeEventListener("pagehide", subito);
    };
  }, [salva]);

  return stato;
}

/** La scritta accanto al riquadro: piccola, non deve rubare l'occhio. */
export function SpiaBozza({ stato }: { stato: StatoBozza }) {
  if (stato === "fermo") return null;
  const testo =
    stato === "scrivo"
      ? "salvo…"
      : stato === "salvata"
        ? "✓ bozza salvata"
        : "⚠ bozza non salvata";
  return <span className={`bozza-spia bozza-spia-${stato}`}>{testo}</span>;
}
