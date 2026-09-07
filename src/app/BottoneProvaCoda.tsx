"use client";

import { useState } from "react";
import { provaCodaIgnoraAction } from "./dashboard/provaRobot";
import type { EsitoRobot } from "@/server/robot/lancia";

// Tasto di PROVA, visibile solo all'amministratore: testa sulla card il
// metodo alternativo «Rispondi alle recensioni» + «Ignora» invece di scorrere
// la lista della sede. NON pubblica MAI (scrive e scarta con «Annulla»),
// esattamente come il tasto G. Mostra anche il passo-passo per capire subito
// dove il metodo si ferma, senza aprire gli screenshot sul server.

export function BottoneProvaCoda({ chiave }: { chiave: string }) {
  const [provando, setProvando] = useState(false);
  const [esito, setEsito] = useState<EsitoRobot | null>(null);

  async function prova() {
    if (provando) return;
    setEsito(null);
    setProvando(true);
    try {
      setEsito(await provaCodaIgnoraAction(chiave));
    } catch {
      setEsito({
        ok: false,
        stato: "errore",
        messaggio: "Qualcosa è andato storto nell'avvio del test.",
      });
    } finally {
      setProvando(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn-mini"
        onClick={prova}
        disabled={provando}
        aria-busy={provando}
        title="Prova (solo admin): cerca questa recensione con la coda «Rispondi alle recensioni» + «Ignora». Non pubblica mai. Serve Chrome chiuso."
      >
        {provando ? "🧪 Provo…" : "🧪 Prova coda"}
      </button>

      {esito && (
        <div className="google-esito" role="status" aria-live="polite">
          <span className={esito.ok ? "flag flag-green" : "flag flag-amber"}>
            {esito.messaggio}
          </span>
          {esito.log && esito.log.length > 0 && (
            // Aperto SUBITO quando non è andata a buon fine: è lì che sta la
            // diagnostica (i controlli visti davvero), non serve doverla aprire.
            <details className="hint" open={!esito.ok}>
              <summary>Passo-passo ({esito.log.length})</summary>
              <ol>
                {esito.log.map((riga, i) => (
                  <li key={i}>{riga}</li>
                ))}
              </ol>
            </details>
          )}
        </div>
      )}
    </>
  );
}
