import { etichettaStelle } from "@/server/integrations/freshdeskChiusura";
import type { Recensione } from "@/server/reviews/load";
import { STELLE_FRESHDESK, specificaStelle } from "./connectors";
import type { Regola } from "./types";

// ---------------------------------------------------------------------------
// Controllo delle regole PRIMA di salvarle.
//
// Nasce da un caso vero: la regola «1 e 2 stelle — escalation» è stata scritta
// il 2 settembre con la classificazione «{stelle} stelle», e il nodo non
// sostituiva il segnaposto. Freshdesk rifiutava il valore con un 400 e il
// flusso si fermava lì: 42 negative su 42, dal 9 al 21 settembre, senza tag
// della sede e senza assegnazione a Cherubina. Nessuno se n'è accorto per
// dodici giorni, perché l'errore stava in un nodo a metà flusso.
//
// Qui la domanda si fa al momento giusto — quando la regola si salva — e per
// OGNI punteggio che la regola copre: «con 1★, questo nodo manderebbe un
// valore che Freshdesk accetta, ed è quello giusto?». Se no, non si salva.
//
// Si controlla solo ciò che si conosce con certezza: l'elenco dei valori del
// campo «Stelle», che è Freshdesk stesso a dichiarare nel messaggio d'errore.
// Gli altri campi non si verificano, per non inventare vincoli che non ci sono.
// ---------------------------------------------------------------------------

/** Una recensione di prova con solo le stelle: basta a risolvere i segnaposto. */
function recensioneDiProva(stelle: number): Recensione {
  return { stelle, nome: "", sede: "", originale: "", italiano: null } as unknown as Recensione;
}

/**
 * I problemi delle regole, in italiano, uno per riga. Vuoto = si può salvare.
 * Vale anche per le regole SPENTE: si accendono con un clic, e allora sarebbe
 * troppo tardi per accorgersene.
 */
export function problemiDelleRegole(regole: Regola[]): string[] {
  const problemi: string[] = [];
  for (const r of regole) {
    const stelleCoperte = (r.condizione?.stelle ?? []).filter((s) => s >= 1 && s <= 5);
    for (const a of r.azioni) {
      if (a.tipo !== "freshdesk.classifica") continue;
      const parametro = (a.parametri.specifica2 ?? "").trim();
      if (!parametro) continue; // nessun valore: il campo non si manda, e va bene
      for (const s of stelleCoperte) {
        const valore = specificaStelle(parametro, recensioneDiProva(s));
        if (!valore) {
          problemi.push(
            `«${r.nome}», nodo ${a.id}: con ${s}★ il valore «${parametro}» non è fra quelli che Freshdesk accetta (${STELLE_FRESHDESK.join(", ")}).`,
          );
        } else if (valore !== etichettaStelle(s)) {
          problemi.push(
            `«${r.nome}», nodo ${a.id}: con ${s}★ classificherebbe «${valore}» invece di «${etichettaStelle(s)}».`,
          );
        }
      }
    }
  }
  return problemi;
}
