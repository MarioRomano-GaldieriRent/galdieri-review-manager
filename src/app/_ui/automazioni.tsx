import { CATALOGO, type Azione, type EsitoNodo, type Regola } from "@/server/automation/types";
import { salvaNodoAction } from "../impostazioni/actions";

// Pezzi grafici condivisi fra i due pannelli:
//   Impostazioni → NodoEditor, per configurare il flusso
//   Automazioni  → NodoEseguito, per vedere com'è andata
// La cartella _ui non è una rotta: Next ignora i nomi che iniziano con _.

export const ICONA: Record<string, string> = {
  freshdesk: "🎫",
  google: "★",
  email: "✉",
  sistema: "⏸",
};

export function descriviCondizione(r: Regola): string {
  const stelle = r.condizione.stelle.map((s) => `${s}★`).join(" o ");
  const testo =
    r.condizione.testo === "con"
      ? " con testo"
      : r.condizione.testo === "senza"
        ? " senza testo"
        : "";
  return `${stelle}${testo}`;
}

/** Un nodo del flusso, apribile per modificarne i parametri. */
export function NodoEditor({ regola, azione }: { regola: Regola; azione: Azione }) {
  const meta = CATALOGO[azione.tipo];
  return (
    <details className={`nodo nodo-${meta.servizio}`}>
      <summary className="nodo-testa">
        <span className="nodo-icona">{ICONA[meta.servizio]}</span>
        <span className="nodo-titolo">{meta.titolo}</span>
        <span className={`nodo-tipo ${meta.scrittura ? "nodo-scrive" : "nodo-legge"}`}>
          {meta.scrittura ? "scrive" : "legge"}
        </span>
      </summary>
      <div className="nodo-corpo">
        <p className="hint">{meta.descrizione}</p>
        {meta.parametri.length === 0 ? (
          <p className="hint">Nessun parametro da configurare.</p>
        ) : (
          <form action={salvaNodoAction}>
            <input type="hidden" name="regolaId" value={regola.id} />
            <input type="hidden" name="azioneId" value={azione.id} />
            {meta.parametri.map((p) => (
              <label key={p.nome} className="field">
                <span>{p.etichetta}</span>
                {p.multilinea ? (
                  <textarea
                    name={`p_${p.nome}`}
                    rows={3}
                    defaultValue={azione.parametri[p.nome] ?? ""}
                  />
                ) : (
                  <input name={`p_${p.nome}`} defaultValue={azione.parametri[p.nome] ?? ""} />
                )}
                {p.aiuto && <small className="hint">{p.aiuto}</small>}
              </label>
            ))}
            <button type="submit" className="btn-mini">
              Salva nodo
            </button>
          </form>
        )}
      </div>
    </details>
  );
}

/** Esito di un nodo dopo un'esecuzione. */
export function NodoEseguito({ n }: { n: EsitoNodo }) {
  const simbolo =
    n.stato === "ok" ? "✓" : n.stato === "simulato" ? "◐" : n.stato === "saltato" ? "–" : "✕";
  return (
    <div className={`run-nodo run-${n.stato} nodo-${n.servizio}`}>
      <div className="run-nodo-testa">
        <span className="run-simbolo">{simbolo}</span>
        <span className="nodo-icona">{ICONA[n.servizio]}</span>
        <span className="nodo-titolo">{n.titolo}</span>
        <span className="run-durata">{n.durataMs} ms</span>
      </div>
      <p className="run-messaggio">{n.messaggio}</p>
      {n.chiamata && (
        <details className="run-chiamata">
          <summary>
            {n.stato === "ok" ? "Chiamata effettuata" : "Chiamata che sarebbe stata fatta"}
          </summary>
          <pre>
            {n.chiamata.metodo} {n.chiamata.url}
            {n.chiamata.corpo ? `\n\n${n.chiamata.corpo}` : ""}
          </pre>
        </details>
      )}
    </div>
  );
}
