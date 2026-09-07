"use server";

import { richiediOperatore } from "@/server/auth/sessione";
import { leggiRecensione } from "@/server/db/recensioni";
import { nomeGoogleDiSede } from "@/server/db/sedi";
import { avviaRobotConEsito, type EsitoRobot } from "@/server/robot/lancia";

// Tasto di PROVA (solo admin) sulla card: testa il metodo alternativo di
// ricerca — la coda «Rispondi alle recensioni» + «Ignora» di Google, invece di
// scorrere/cercare nella lista intera della sede — su UNA recensione precisa.
//
// Come «cerca» (il tasto G): NON pubblica mai. Scrive un testo di prova nel
// riquadro e lo scarta subito («Annulla»). Ritorna anche il passo-passo (log)
// così si vede dove il metodo si ferma, senza dover leggere gli screenshot sul
// server.

const TESTO_PROVA = "PROVA — non pubblicare";

export async function provaCodaIgnoraAction(chiave: string): Promise<EsitoRobot> {
  const op = await richiediOperatore();
  if (op.ruolo !== "admin") {
    return {
      ok: false,
      stato: "non-autorizzato",
      messaggio: "Questo tasto di prova è visibile solo all'amministratore.",
    };
  }

  const r = await leggiRecensione(chiave);
  if (!r) {
    return {
      ok: false,
      stato: "recensione-non-trovata",
      messaggio: "Recensione non più in elenco: aggiorna la pagina e riprova.",
    };
  }

  const nomeGoogle = await nomeGoogleDiSede(r.sede);
  if (!nomeGoogle) {
    return {
      ok: false,
      stato: "sede-non-mappata",
      messaggio: `La sede «${r.sede}» non è mappata su Google: serve il nome esatto dell'attività (pannello Mapping) per aprirla direttamente.`,
    };
  }

  // Attesa più larga del solito: la coda può richiedere decine di «Ignora».
  // Il robot ha una scadenza INTERNA più corta (200 s), così torna da sé col
  // passo-passo invece di far scadere questa attesa senza dire niente.
  return avviaRobotConEsito(
    {
      azione: "prova-coda",
      nome: r.nome,
      testo: TESTO_PROVA,
      nomeGoogle,
      // Il testo vero della recensione: è così che la coda riconosce QUALE
      // recensione ha davanti, invece di fidarsi di un nome che può essere
      // una sola lettera.
      testoRecensione: r.originale,
    },
    { attesaMs: 240_000 },
  );
}
