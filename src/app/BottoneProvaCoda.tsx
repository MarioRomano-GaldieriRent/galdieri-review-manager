"use client";

import { useState } from "react";
import { provaCodaIgnoraAction } from "./dashboard/provaRobot";
import type { EsitoRobot } from "@/server/robot/lancia";

// Tasto di PROVA, visibile solo all'amministratore: testa sulla card il metodo
// alternativo di ricerca — la coda «Rispondere a recensioni» + «Ignora» —
// invece di scorrere la lista della sede. NON pubblica MAI: scrive un testo di
// prova, controlla che il tasto d'invio si accenda e poi svuota il campo ed
// esce con «Ignora», senza toccare l'invio.
//
// Il passo-passo è la parte utile: dice a che punto si è fermato e QUALI
// controlli ha visto davvero sulla pagina, così i selettori si calibrano senza
// aprire gli screenshot sul server. Il primo rigo è la sigla della versione:
// se non c'è, sul server sta girando ancora il codice vecchio (manca
// «npm run build» + restart dopo il git pull).

export function BottoneProvaCoda({ chiave }: { chiave: string }) {
  const [provando, setProvando] = useState(false);
  const [esito, setEsito] = useState<EsitoRobot | null>(null);
  const [copiato, setCopiato] = useState(false);

  async function prova() {
    if (provando) return;
    setEsito(null);
    setCopiato(false);
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

  async function copia() {
    if (!esito) return;
    const testo = [esito.messaggio, "", ...(esito.log ?? [])].join("\n");
    try {
      await navigator.clipboard.writeText(testo);
      setCopiato(true);
    } catch {
      setCopiato(false);
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
        title="Prova (solo admin): cerca questa recensione con la coda «Rispondere a recensioni» + «Ignora». Non pubblica mai. Serve Chrome chiuso sul server."
      >
        {provando ? "🧪 Provo…" : "🧪 Prova coda"}
      </button>

      {esito && (
        <div className="google-esito" role="status" aria-live="polite">
          <span className={esito.ok ? "flag flag-green" : "flag flag-amber"}>
            {esito.messaggio}
          </span>
          {esito.log && esito.log.length > 0 ? (
            // Aperto SUBITO quando non è andata a buon fine: è lì che sta la
            // diagnostica (i controlli visti davvero), non serve doverla aprire.
            <details className="hint" open={!esito.ok}>
              <summary>Passo-passo ({esito.log.length})</summary>
              <ol className="prova-log">
                {esito.log.map((riga, i) => (
                  <li key={i}>{riga}</li>
                ))}
              </ol>
              <button type="button" className="btn-mini" onClick={copia}>
                {copiato ? "✅ Copiato" : "📋 Copia il passo-passo"}
              </button>
            </details>
          ) : (
            <span className="hint">
              Nessun passo-passo: il robot non è arrivato a raccontare niente. Se capita sempre,
              controlla che sul server sia stato fatto «npm run build» e il restart dopo il git pull.
            </span>
          )}
        </div>
      )}
    </>
  );
}
