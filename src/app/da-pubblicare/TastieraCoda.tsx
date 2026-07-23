"use client";

import { useEffect, useState } from "react";

// Flusso a lotti da tastiera per smaltire tante recensioni senza il mouse.
// Non ridisegna la lista: agisce sulle righe già rese dal server, trovandole
// nel DOM. Evidenzia la riga attiva e mappa i tasti sui suoi controlli.
//
//   C      copia la risposta della riga attiva
//   G      apre la sede su Google
//   Invio  segna come pubblicata (e la pagina si ricarica: la riga sparisce,
//          l'attiva torna in cima, si continua a premere Invio)
//   ↑ ↓    cambia riga
//
// I tasti si ignorano quando il fuoco è in un campo di testo.

export function TastieraCoda() {
  const [attiva, setAttiva] = useState(0);

  useEffect(() => {
    const righe = () => Array.from(document.querySelectorAll<HTMLElement>(".pub-card"));

    function evidenzia(i: number) {
      const cs = righe();
      cs.forEach((c, j) => c.classList.toggle("is-active", j === i));
      cs[i]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
    evidenzia(attiva);

    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;

      const cs = righe();
      if (cs.length === 0) return;
      const i = Math.min(attiva, cs.length - 1);
      const riga = cs[i];

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setAttiva(Math.min(i + 1, cs.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setAttiva(Math.max(i - 1, 0));
          break;
        case "c":
        case "C":
          e.preventDefault();
          riga?.querySelector<HTMLButtonElement>("[data-copia]")?.click();
          break;
        case "g":
        case "G": {
          e.preventDefault();
          const a = riga?.querySelector<HTMLAnchorElement>('a[target="_blank"]');
          if (a) window.open(a.href, "_blank", "noopener");
          break;
        }
        case "Enter":
          e.preventDefault();
          riga?.querySelector<HTMLFormElement>("form[data-segna]")?.requestSubmit();
          break;
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [attiva]);

  return (
    <p className="pub-tastiera hint">
      A tastiera: <kbd>C</kbd> copia · <kbd>G</kbd> apri su Google · <kbd>Invio</kbd> segna
      pubblicata · <kbd>↑</kbd> <kbd>↓</kbd> cambia riga
    </p>
  );
}
