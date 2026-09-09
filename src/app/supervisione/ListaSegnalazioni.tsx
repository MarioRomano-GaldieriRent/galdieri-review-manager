"use client";

import { useState, type ReactNode } from "react";
import { BottoneTest } from "../BottoneTest";
import { VediMail } from "../VediMail";
import {
  chiudiGiaGestitaAction,
  rimettiInCodaSegnalazioneAction,
  type EsitoChiusura,
} from "./actions";

// La lista delle segnalazioni aperte, gestita dal browser.
//
// Perché non è più un form. Chiudere una segnalazione è un clic, e un clic deve
// avere un effetto SUBITO. Con `<form action={...}>` + `redirect` il browser
// restava fermo senza dire niente finché il server non aveva ri-renderizzato
// tutta la pagina — statistiche comprese — e chi premeva vedeva «non è successo
// niente»: la riga spariva solo ricaricando a mano.
//
// Adesso l'azione ritorna un esito e la card se ne va da qui, all'istante: al
// suo posto resta una riga di conferma, e il conteggio in alto scala di uno. Il
// contenuto delle card arriva già renderizzato dal server (`contenuto`), quindi
// nel pacchetto JavaScript non finiscono né i testi delle recensioni né i
// formattatori di data.
//
// La conferma non è un dettaglio: una card che sparisce e basta si legge come
// un difetto. Una riga che dice cosa è successo si legge come una conferma, e
// occupa un rigo invece di venti.

export type VoceSegnalazione = {
  chiave: string;
  nome: string;
  messaggioId: string;
  /** La card, già renderizzata dal server. */
  contenuto: ReactNode;
};

type Fatta = { messaggio: string };

export function ListaSegnalazioni({ voci, nota }: { voci: VoceSegnalazione[]; nota: ReactNode }) {
  const [fatte, setFatte] = useState<Record<string, Fatta>>({});
  const rimaste = voci.length - Object.keys(fatte).length;

  return (
    <>
      <div className="sec-head">
        <h2>Segnalazioni aperte</h2>
        {rimaste > 0 && <span className="chip-count">{rimaste}</span>}
      </div>
      {nota}
      {rimaste === 0 && <p className="dash-vuoto">Nessuna segnalazione aperta.</p>}
      {voci.map((v) => {
        const fatta = fatte[v.chiave];
        if (fatta) {
          return (
            <p key={v.chiave} className="segnalazione-fatta" role="status">
              ✓ «{v.nome || "senza nome"}» {fatta.messaggio}
            </p>
          );
        }
        return (
          <article key={v.chiave} className="card dash-card segnalazione-card">
            {v.contenuto}
            <Azioni
              voce={v}
              onFatta={(f) => setFatte((prima) => ({ ...prima, [v.chiave]: f }))}
            />
          </article>
        );
      })}
    </>
  );
}

type InCorso = "chiudi" | "rimetti" | null;

function Azioni({ voce, onFatta }: { voce: VoceSegnalazione; onFatta: (f: Fatta) => void }) {
  const [testo, setTesto] = useState("");
  const [inCorso, setInCorso] = useState<InCorso>(null);
  const [errore, setErrore] = useState("");

  async function esegui(quale: Exclude<InCorso, null>) {
    if (inCorso) return; // un tasto alla volta: niente doppio invio
    setInCorso(quale);
    setErrore("");
    try {
      const azione =
        quale === "chiudi" ? chiudiGiaGestitaAction : rimettiInCodaSegnalazioneAction;
      const esito: EsitoChiusura = await azione(voce.chiave, testo);
      if (esito.ok) onFatta({ messaggio: esito.messaggio });
      else {
        setErrore(esito.errore);
        setInCorso(null);
      }
    } catch (e) {
      setErrore(e instanceof Error ? e.message : "Non è riuscita: riprova.");
      setInCorso(null);
    }
  }

  return (
    <div className="segnalazione-chiusura">
      <textarea
        className="dash-testo"
        rows={2}
        maxLength={1000}
        value={testo}
        onChange={(e) => setTesto(e.target.value)}
        disabled={inCorso !== null}
        placeholder="Cos'era e perché la chiudi (finisce sotto la card in «Archiviate»)…"
        aria-label="Nota di chiusura"
      />
      <div className="dash-azioni">
        <button
          type="button"
          className="btn-primary"
          onClick={() => esegui("chiudi")}
          disabled={inCorso !== null}
          aria-busy={inCorso === "chiudi"}
          title="La recensione risulta gestita e va in «Archiviate»: non torna né a te né all'operatore"
        >
          {inCorso === "chiudi" ? (
            <span className="btn-caricamento">
              <span className="spinner-mini spinner-chiaro" aria-hidden="true" />
              Chiudo…
            </span>
          ) : (
            "✓ Chiudi: già gestita"
          )}
        </button>
        <button
          type="button"
          className="btn-mini"
          onClick={() => esegui("rimetti")}
          disabled={inCorso !== null}
          aria-busy={inCorso === "rimetti"}
          title="La recensione torna in «Da approvare» dell'operatore"
        >
          {inCorso === "rimetti" ? (
            <span className="btn-caricamento">
              <span className="spinner-mini" aria-hidden="true" />
              Rimetto…
            </span>
          ) : (
            "↩ Rimetti in coda"
          )}
        </button>
        {/* Il perché di una segnalazione è quasi sempre «il robot non la trova»:
            il Test lo manda a cercarla e riporta il passo-passo, qui dove si
            decide, senza pubblicare niente. */}
        <BottoneTest chiave={voce.chiave} />
        <VediMail id={voce.messaggioId} className="btn-mini" />
      </div>
      {errore && <p className="form-error segnala-esito">{errore}</p>}
    </div>
  );
}
