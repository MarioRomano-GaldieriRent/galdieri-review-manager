"use client";

import { useState } from "react";

// Copia il testo della risposta negli appunti. La Clipboard API è la via
// normale; per i browser che la bloccano (o senza HTTPS) c'è il ripiego con la
// textarea nascosta. Feedback "Copiato ✓" per un attimo sul pulsante.

function ripiego(testo: string): void {
  const ta = document.createElement("textarea");
  ta.value = testo;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand("copy");
  } catch {
    // nulla da fare: l'operatore selezionerà a mano
  }
  document.body.removeChild(ta);
}

export function CopiaRisposta({ testo }: { testo: string }) {
  const [copiato, setCopiato] = useState(false);

  async function copia() {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(testo);
      else ripiego(testo);
    } catch {
      ripiego(testo);
    }
    setCopiato(true);
    setTimeout(() => setCopiato(false), 1500);
  }

  return (
    <button type="button" className="btn-secondary" data-copia onClick={copia}>
      {copiato ? "Copiato ✓" : "Copia risposta"}
    </button>
  );
}
