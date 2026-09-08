"use client";

import { useState } from "react";
import { provaCodaIgnoraAction } from "./dashboard/provaRobot";
import type { EsitoRobot } from "@/server/robot/lancia";

// Tasto «Test», accanto a «Rispondi» e uguale a lui: prova sulla card il
// percorso del robot — la coda «Rispondere a recensioni» + «Ignora» — senza
// pubblicare niente. Visibile solo all'amministratore.
//
// Quando trova la recensione giusta SI FERMA lì: risposta scritta nel riquadro,
// recensione a schermo, finestra del robot lasciata APERTA sul server. Non
// pubblica e non scarta: serve a guardare con i propri occhi che sia davvero
// quella, e poi decidere. La finestra la chiude la persona (o si chiude da sé
// dopo mezz'ora); finché resta aperta il robot è occupato e gli altri tasti
// aspettano.
//
// Il passo-passo è l'altra parte utile: elenca l'autore di OGNI recensione che
// ha scorso e perché l'ha scartata, poi il testo per intero di quella scelta.
// Il primo rigo è la sigla della versione: se non c'è, sul server sta girando
// ancora il codice vecchio (manca «npm run build» + restart dopo il git pull).

export function BottoneTest({ chiave }: { chiave: string }) {
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
        className="btn-test"
        onClick={prova}
        disabled={provando}
        aria-busy={provando}
        title="Test (solo admin): cerca questa recensione col robot e, quando la trova, scrive la risposta e SI FERMA lì, lasciando la finestra aperta sul server perché tu controlli. Non pubblica e non scarta. Serve Chrome chiuso sul server."
      >
        {provando ? (
          <span className="btn-caricamento">
            <span className="spinner-mini spinner-chiaro" aria-hidden="true" />
            Test in corso…
          </span>
        ) : (
          "Test"
        )}
      </button>

      {esito && (
        <div className="google-esito" role="status" aria-live="polite">
          <span className={esito.ok ? "flag flag-green" : "flag flag-amber"}>{esito.messaggio}</span>
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
              controlla che sul server sia stato fatto «npm run build» e il restart dopo il git
              pull.
            </span>
          )}
        </div>
      )}
    </>
  );
}
