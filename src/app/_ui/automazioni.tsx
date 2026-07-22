import { CATALOGO, type Azione, type EsitoNodo, type Regola } from "@/server/automation/types";
import { salvaNodoAction } from "../impostazioni/actions";

// Pezzi grafici condivisi fra i due pannelli:
//   Impostazioni → PassoRegola, per capire e configurare il flusso
//   Automazioni  → NodoEseguito, per vedere com'è andata

export const ICONA: Record<string, string> = {
  freshdesk: "🎫",
  google: "★",
  email: "✉",
  sistema: "⏸",
};

/** Chi sono gli id degli agenti Freshdesk, così non si legge un numero nudo. */
const AGENTI: Record<string, string> = {
  "80108775423": "Ufficio Marketing",
  "80128977810": "Cherubina Panico",
};

const STATI: Record<string, string> = {
  "2": "Aperto",
  "3": "In attesa",
  "4": "Risolto",
  "5": "Chiuso",
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

/** La condizione detta a parole, per l'intestazione della regola. */
export function quandoScatta(r: Regola): string {
  const stelle = r.condizione.stelle.map((s) => (s === 1 ? "1 stella" : `${s} stelle`)).join(" o ");
  if (r.condizione.testo === "con") return `Quando arriva una recensione da ${stelle} CON commento`;
  if (r.condizione.testo === "senza")
    return `Quando arriva una recensione da ${stelle} SENZA commento`;
  return `Quando arriva una recensione da ${stelle}`;
}

/** Quanti passaggi toccano il mondo esterno, detto in italiano corretto. */
export function quantiModificano(r: Regola): string {
  const n = r.azioni.filter((a) => CATALOGO[a.tipo].scrittura).length;
  if (n === 0) return "Nessuno di essi modifica qualcosa fuori dall'applicazione.";
  if (n === 1) return "Uno solo di essi modifica qualcosa fuori dall'applicazione.";
  return `${n} di essi modificano qualcosa fuori dall'applicazione.`;
}

/** Rende leggibili i segnaposto: {sede} da solo non dice nulla a chi legge. */
function leggibile(testo: string): string {
  return testo
    .replace(/\{sede\}/g, "«tag della sede»")
    .replace(/\{sedeEstesa\}/g, "«nome della sede»")
    .replace(/\{personale\}/g, "«personale, se il cliente cita qualcuno»")
    .replace(/\{nome\}/g, "«nome del cliente»")
    .replace(/\{stelle\}/g, "«numero di stelle»")
    .replace(/\{commento\}/g, "«testo della recensione»");
}

/**
 * Cosa farà davvero questo passo, con i valori configurati adesso.
 * Una riga per concetto: si legge senza aprire nulla.
 */
export function cosaFa(a: Azione): string[] {
  const p = a.parametri;
  const righe: string[] = [];

  switch (a.tipo) {
    case "email.rispondi": {
      righe.push(`Risponde all'email scrivendo «${p.testo ?? ""}»`);
      if (p.testoInglese) righe.push(`Se la recensione non è in italiano: «${p.testoInglese}»`);
      righe.push(p.a ? `Destinatario: ${p.a}` : "Va a customer.care, come indicato dall'email");
      righe.push("È questa risposta che fa nascere il ticket su Freshdesk");
      return righe;
    }
    case "email.inoltra": {
      righe.push(`Inoltra a ${p.a || "—"}`);
      if (p.cc) righe.push(`In copia a ${p.cc} — è la copia che fa nascere il ticket`);
      else righe.push("Nessuna copia: senza di essa il ticket non nascerà");
      righe.push(`Con il testo «${leggibile(p.testo ?? "")}»`);
      return righe;
    }
    case "freshdesk.trovaTicket":
      return [
        "Cerca su Freshdesk il ticket di questa recensione",
        "Devono coincidere oggetto, data e nome del cliente: se non tornano tutti e tre non aggancia nulla, per non lavorare il ticket di un altro",
      ];
    case "freshdesk.classifica":
      return [
        `Tipo ticket: «${p.tipo ?? "—"}»`,
        `Classificazione: gestione recensioni clienti → ${p.specifica1 ?? "—"} → ${p.specifica2 ?? "—"}`,
      ];
    case "freshdesk.tag":
      return [
        `Applica i tag: ${leggibile(p.tag ?? "") || "nessuno"}`,
        "I tag già presenti sul ticket restano",
      ];
    case "freshdesk.assegna": {
      const id = p.agenteId ?? "";
      return [`Assegna a ${AGENTI[id] ? `${AGENTI[id]} (${id})` : `agente ${id || "—"}`}`];
    }
    case "freshdesk.stato":
      return [`Porta il ticket allo stato «${STATI[p.stato ?? ""] ?? p.stato ?? "—"}»`];
    case "google.rispondi": {
      righe.push(`Pubblica sotto la recensione: «${leggibile(p.testo ?? "")}»`);
      if (p.testoInglese)
        righe.push(`Se la recensione non è in italiano: «${leggibile(p.testoInglese)}»`);
      righe.push("Serve l'API Google, ancora da abilitare: per ora resta in prova");
      return righe;
    }
    case "sistema.attendiRisposta":
      return [
        `Il flusso si ferma qui e aspetta la risposta di ${p.da || "—"}`,
        "Nei casi reali arriva dopo 4-6 giorni, e da lì in poi serve una persona",
      ];
    default:
      return [];
  }
}

/**
 * Un passo della regola: numero, cosa fa in parole, e il modulo per
 * modificarlo nascosto finché non serve.
 */
export function PassoRegola({
  regola,
  azione,
  numero,
  ultimo,
}: {
  regola: Regola;
  azione: Azione;
  numero: number;
  ultimo: boolean;
}) {
  const meta = CATALOGO[azione.tipo];
  const righe = cosaFa(azione);

  return (
    <li className={`passo nodo-${meta.servizio}${ultimo ? " passo-ultimo" : ""}`}>
      <span className="passo-numero" aria-hidden="true">
        {numero}
      </span>

      <div className="passo-corpo">
        <div className="passo-testa">
          <span className="nodo-icona">{ICONA[meta.servizio]}</span>
          <span className="passo-titolo">{meta.titolo}</span>
          <span className={`nodo-tipo ${meta.scrittura ? "nodo-scrive" : "nodo-legge"}`}>
            {meta.scrittura ? "modifica qualcosa" : "solo lettura"}
          </span>
        </div>

        <ul className="passo-righe">
          {righe.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>

        {meta.parametri.length > 0 && (
          <details className="passo-modifica">
            <summary>Modifica questo passo</summary>
            <p className="hint">{meta.descrizione}</p>
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
                Salva
              </button>
            </form>
          </details>
        )}
      </div>
    </li>
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
