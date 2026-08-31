"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Auto-aggiornamento SILENZIOSO della lista "Da approvare": ogni tot minuti
// ricontrolla (anche su Freshdesk, via ?fresh=1) e toglie le recensioni gestite
// nel frattempo da qualcun altro. Non mostra nulla a schermo: il fatto che si
// aggiorni da sola sta nel tooltip dell'icona di aggiornamento. Accortezze:
//   - NON parte mentre stai scrivendo (textarea/input a fuoco);
//   - salta se la scheda è in secondo piano, ma riparte al ritorno in primo piano;
//   - refresh "morbido" (router.refresh), non un ricaricamento pieno.

const MINUTI = 3;

export function AutoAggiorna() {
  const router = useRouter();

  useEffect(() => {
    const tick = () => {
      const el = document.activeElement;
      if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT")) return; // stai scrivendo
      if (document.visibilityState === "hidden") return; // scheda in secondo piano
      // Si conserva lo stato della vista (occhio "tutte", tab, sede): senza,
      // forzare "/?fresh=1" farebbe sparire da sole le recensioni che l'operatore
      // sta guardando con l'occhio acceso. I parametri volatili (run, esito*)
      // NON si riportano, così l'auto-refresh non ripropone banner vecchi.
      const cur = new URLSearchParams(window.location.search);
      if (cur.get("fresh") === "1") {
        router.refresh();
        return;
      }
      const next = new URLSearchParams();
      for (const k of ["step", "sede", "tutte"]) {
        const v = cur.get(k);
        if (v) next.set(k, v);
      }
      next.set("fresh", "1");
      router.replace(`/?${next.toString()}`, { scroll: false });
    };
    const onVisibile = () => {
      if (document.visibilityState === "visible") tick();
    };
    const id = setInterval(tick, MINUTI * 60 * 1000);
    document.addEventListener("visibilitychange", onVisibile);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibile);
    };
  }, [router]);

  return null;
}
