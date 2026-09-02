"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Auto-aggiornamento SILENZIOSO della lista "Da approvare": ogni tot minuti
// ricontrolla e toglie le recensioni gestite nel frattempo da qualcun altro.
// Non mostra nulla a schermo. Accortezze:
//   - NON parte mentre stai scrivendo (textarea/input a fuoco);
//   - salta se la scheda è in secondo piano, ma riparte al ritorno in primo piano;
//   - refresh SEMPRE MORBIDO: MAI forza il bypass delle cache Freshdesk.
//
// Perché mai forzato: le cache brevi del server (posta 90s, ticket Freshdesk 60s)
// scadono comunque fra un tick e l'altro (3 min), quindi i dati si rinfrescano da
// soli — forzare a ogni tick significherebbe ripagare 6+ pagine di ticket e i
// corpi ogni 3 minuti (e a ogni ritorno di scheda), fino a far scattare il 429.
// Solo il CLICK manuale su «Aggiorna» (href /?fresh=1) deve forzare.

const MINUTI = 3;

export function AutoAggiorna() {
  const router = useRouter();

  useEffect(() => {
    // Refresh morbido. Se l'URL porta ancora parametri "volatili" (fresh da un
    // click manuale, o run/esito di un banner), si ricostruisce un URL pulito
    // con la sola vista (tab/sede) e si naviga lì — così l'auto-refresh non
    // eredita mai fresh=1 e non ripropone banner vecchi. Altrimenti basta un
    // router.refresh(), che cavalca le cache.
    const rinfresca = () => {
      const cur = new URLSearchParams(window.location.search);
      const haVolatili =
        cur.get("fresh") === "1" || cur.has("run") || [...cur.keys()].some((k) => k.startsWith("esito"));
      if (haVolatili) {
        const pulito = new URLSearchParams();
        for (const k of ["step", "sede"]) {
          const v = cur.get(k);
          if (v) pulito.set(k, v);
        }
        const q = pulito.toString();
        router.replace(q ? `/?${q}` : "/", { scroll: false });
      } else {
        router.refresh();
      }
    };

    const tick = () => {
      const el = document.activeElement;
      if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT")) return; // stai scrivendo
      if (document.visibilityState === "hidden") return; // scheda in secondo piano
      rinfresca();
    };
    const onVisibile = () => {
      if (document.visibilityState === "visible") rinfresca();
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
