"use server";

import { richiediOperatore } from "@/server/auth/sessione";
import { generaRispostaSuggerita } from "@/server/ai/rispostaSuggerita";
import { isClaudeConfigured } from "@/server/ai/claude";
import { leggiSuggerimento, salvaSuggerimento, scartaSuggerimento } from "@/server/db/suggerimenti";
import { leggiRecensione } from "@/server/db/recensioni";

// Generazione della risposta suggerita per UNA recensione, chiamata dal campo
// della card mentre la pagina è già visibile (non blocca il caricamento).
//
// La proposta si genera una volta sola e resta salvata: ai ricarichi successivi
// arriva dal database, senza attesa e senza rispendere. «Rigenera» la butta e
// ne chiede un'altra.
//
// Non pubblica NULLA: restituisce solo il testo da mettere nel box, che una
// persona deve rileggere e confermare.

export type EsitoSuggerimento =
  { ok: true; testo: string; dallaCache: boolean } | { ok: false; errore: string };

export async function suggerisciAction(
  chiave: string,
  opts: { rigenera?: boolean } = {},
): Promise<EsitoSuggerimento> {
  // Le server action sono endpoint a sé: il ruolo si ricontrolla qui.
  await richiediOperatore();

  if (!chiave) return { ok: false, errore: "Recensione non indicata." };
  if (!isClaudeConfigured()) {
    return { ok: false, errore: "Claude non è configurato (manca ANTHROPIC_API_KEY nel .env)." };
  }

  try {
    // Con «Rigenera» si tiene da parte la proposta precedente: serve a chiedere
    // una formulazione diversa, altrimenti tornerebbe la stessa frase.
    let precedente = "";
    const gia = await leggiSuggerimento(chiave);
    if (opts.rigenera) {
      precedente = gia?.testo ?? "";
      await scartaSuggerimento(chiave);
    } else if (gia) {
      return { ok: true, testo: gia.testo, dallaCache: true };
    }

    const r = await leggiRecensione(chiave);
    if (!r) return { ok: false, errore: "Recensione non trovata in archivio." };

    const commento = (r.originale || "").trim();
    if (!commento) return { ok: false, errore: "Recensione senza commento: vale «Grazie.»." };
    if ((r.stelle ?? 0) < 4) {
      return { ok: false, errore: "Le recensioni negative le gestisce il customer care." };
    }

    const s = await generaRispostaSuggerita(
      {
        nome: r.nome,
        stelle: r.stelle,
        commento,
        sede: r.sede,
        lingua: r.lingua ?? "",
      },
      { evita: precedente },
    );

    await salvaSuggerimento(chiave, {
      testo: s.testo,
      lingua: s.linguaRisposta,
      modello: s.modello,
      esempiUsati: s.esempiUsati,
      costo: s.consumo.costo,
    });

    return { ok: true, testo: s.testo, dallaCache: false };
  } catch (e) {
    // Un guasto dell'AI non deve rompere la pagina: il box resta scrivibile a mano.
    const msg = e instanceof Error ? e.message : "errore sconosciuto";
    console.warn("[ai] suggerimento non riuscito:", msg);
    return { ok: false, errore: msg };
  }
}
