import { readFileSync } from "node:fs";
import path from "node:path";
// Solo il TIPO: si cancella in compilazione, quindi non apre il database prima
// che l'ambiente sia caricato — che è il motivo per cui tutto il resto entra
// con un import dinamico dentro main().
import type { VersioneTesto } from "../src/server/db/storicoTesti";

// ---------------------------------------------------------------------------
// Recupero una tantum dello STORICO DEI TESTI.
//   npm run storico:recupero            → prova a vuoto, dice solo che cosa farebbe
//   npm run storico:recupero -- --scrivi → scrive davvero
//
// Da oggi lo storico si riempie da solo, ma indietro nel tempo c'è già del
// materiale sparso in quattro archivi che nessuno aveva mai messo insieme:
//
//   memoria_esempi    le risposte vere di Stefania, con la recensione a cui
//                     rispondevano. È la fonte più ricca, ed è agganciabile
//                     perché `conversationId` È la chiave della recensione.
//   pubblicazioni     il testo approvato e quello della recensione, interi.
//   esecuzioni        l'istantanea della recensione al momento del flusso (400
//                     caratteri: può essere tagliata) e gli scostamenti che il
//                     travaso da SQLite si era portato dietro.
//   ai_suggerimenti   le proposte del modello ancora in giro, con quale modello
//                     e con quanti esempi.
//   registro_attivita i primi 120 caratteri di OGNI approvazione — comprese
//                     quelle che una ri-approvazione ha poi sovrascritto. È
//                     l'unico posto dove certe versioni esistono ancora.
//
// Quello che era già stato sovrascritto prima di oggi resta perso: qui si
// ripesca solo ciò che qualche archivio aveva copiato altrove.
//
// Si può rilanciare quante volte si vuole: la dedup dello storico fa sì che un
// secondo giro non aggiunga niente.
// ---------------------------------------------------------------------------

function caricaEnv() {
  try {
    const txt = readFileSync(path.join(process.cwd(), ".env"), "utf8");
    for (const riga of txt.split(/\r?\n/)) {
      const m = riga.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  } catch {
    /* senza .env si prosegue */
  }
}
caricaEnv();

/** Il registro esecuzioni taglia la recensione a 400 caratteri, l'attività a 120. */
const TAGLIO_ESECUZIONI = 400;
const TAGLIO_ATTIVITA = 120;

async function main() {
  const scrivi = process.argv.includes("--scrivi");
  const { db, mongo } = await import("../src/server/db/connessione");
  const { avvia } = await import("../src/server/db/avvio");
  const { registraVersioni, contaStorico } = await import("../src/server/db/storicoTesti");
  const { OPERATORE_SISTEMA } = await import("../src/server/db/attivita");

  await avvia();
  const d = await db();

  // Le chiavi che esistono davvero. Una versione appesa a una recensione che
  // non c'è non serve a niente: non si può né rileggere né accoppiare.
  const chiaviVive = new Set(
    (
      await d
        .collection("recensioni")
        .find({}, { projection: { _id: 1 } })
        .toArray()
    ).map((r) => String(r._id)),
  );
  console.log(`\nRecensioni in archivio: ${chiaviVive.size}`);

  const voci: VersioneTesto[] = [];
  const orfane = { memoria: 0, esecuzioni: 0, pubblicazioni: 0, suggerimenti: 0, attivita: 0 };
  const viva = (k: unknown): k is string => typeof k === "string" && chiaviVive.has(k);

  // — memoria_esempi: le risposte vere, con la recensione accanto ------------
  type DocMemoria = {
    conversationId?: string;
    commento?: string;
    risposta?: string;
    lingua?: string;
    origine?: string;
    inviataIl?: Date;
  };
  for (const m of await d.collection<DocMemoria>("memoria_esempi").find({}).toArray()) {
    const chiave = m.conversationId ?? "";
    if (!viva(chiave)) {
      if (chiave) orfane.memoria += 1;
      continue;
    }
    const quando = m.inviataIl ?? undefined;
    const lingua = m.lingua === "altro" ? null : (m.lingua ?? null);
    if (m.commento?.trim()) {
      voci.push({
        recensioneChiave: chiave,
        tipo: "recensione",
        testo: m.commento,
        lingua,
        origine: "sincronizzazione",
        quando,
        rif: { recuperatoDa: "memoria_esempi" },
      });
    }
    if (m.risposta?.trim()) {
      voci.push({
        recensioneChiave: chiave,
        tipo: "inviata",
        testo: m.risposta,
        lingua,
        // Chi l'ha scritta davvero: il testo di Cherubina che Stefania ha solo
        // rimandato non è una risposta di Stefania, e per l'AI non è lo stesso.
        origine: m.origine === "customer-care" ? "customer-care" : "operatore",
        modo: "reale",
        quando,
        rif: { recuperatoDa: "memoria_esempi" },
      });
    }
  }

  // — pubblicazioni: il testo approvato, intero ------------------------------
  type DocPub = {
    _id: string;
    testoRisposta?: string;
    testoRecensione?: string;
    lingua?: string | null;
    approvataDa?: number;
    approvataIl?: Date;
    pubblicataIl?: Date | null;
  };
  for (const p of await d.collection<DocPub>("pubblicazioni").find({}).toArray()) {
    if (!viva(p._id)) {
      orfane.pubblicazioni += 1;
      continue;
    }
    const quando = p.pubblicataIl ?? p.approvataIl ?? undefined;
    if (p.testoRisposta?.trim()) {
      voci.push({
        recensioneChiave: p._id,
        tipo: "inviata",
        testo: p.testoRisposta,
        lingua: p.lingua ?? null,
        origine: p.approvataDa === OPERATORE_SISTEMA ? "pilota" : "operatore",
        operatoreId: p.approvataDa,
        modo: "reale",
        quando,
        rif: { recuperatoDa: "pubblicazioni" },
      });
    }
    if (p.testoRecensione?.trim()) {
      voci.push({
        recensioneChiave: p._id,
        tipo: "recensione",
        testo: p.testoRecensione,
        origine: "sincronizzazione",
        quando: p.approvataIl ?? undefined,
        rif: { recuperatoDa: "pubblicazioni" },
      });
    }
  }

  // — esecuzioni: l'istantanea della recensione e gli scostamenti ------------
  type DocEsec = {
    _id: string;
    recensioneChiave?: string;
    recensioneTesto?: string;
    modo?: string;
    quando?: Date;
    operatoreId?: number;
    regolaId?: string;
    regolaVersioneId?: number | null;
    scostamenti?: {
      azioneCodice?: string;
      parametro?: string;
      valoreVersione?: string;
      valoreUsato?: string;
    }[];
  };
  for (const e of await d.collection<DocEsec>("esecuzioni").find({}).toArray()) {
    const chiave = e.recensioneChiave ?? "";
    if (!viva(chiave)) {
      if (chiave) orfane.esecuzioni += 1;
      continue;
    }
    const modo = e.modo === "reale" ? ("reale" as const) : ("simulazione" as const);
    const rif = {
      recuperatoDa: "esecuzioni",
      esecuzioneId: e._id,
      regolaId: e.regolaId,
      regolaVersioneId: e.regolaVersioneId ?? null,
    };
    if (e.recensioneTesto?.trim()) {
      voci.push({
        recensioneChiave: chiave,
        tipo: "recensione",
        testo: e.recensioneTesto,
        origine: "sincronizzazione",
        // A 400 caratteri esatti il testo era quasi certamente più lungo: si
        // dichiara tagliato, così non finisce mai in un addestramento.
        troncato: e.recensioneTesto.length >= TAGLIO_ESECUZIONI,
        quando: e.quando,
        rif,
      });
    }
    for (const s of e.scostamenti ?? []) {
      if (s.parametro !== "testo") continue;
      if (s.valoreVersione?.trim()) {
        voci.push({
          recensioneChiave: chiave,
          tipo: "proposta-regola",
          testo: s.valoreVersione,
          origine: "regola",
          quando: e.quando,
          rif,
        });
      }
      if (s.valoreUsato?.trim()) {
        voci.push({
          recensioneChiave: chiave,
          tipo: "inviata",
          testo: s.valoreUsato,
          origine: "operatore",
          operatoreId: e.operatoreId,
          modo,
          quando: e.quando,
          rif,
        });
      }
    }
  }

  // — ai_suggerimenti: le proposte del modello ancora in giro ----------------
  type DocSug = {
    _id: string;
    testo?: string;
    lingua?: string;
    modello?: string;
    esempiUsati?: number;
    generatoIl?: Date;
  };
  for (const s of await d.collection<DocSug>("ai_suggerimenti").find({}).toArray()) {
    if (!viva(s._id)) {
      orfane.suggerimenti += 1;
      continue;
    }
    if (!s.testo?.trim()) continue;
    voci.push({
      recensioneChiave: s._id,
      tipo: "proposta-ai",
      testo: s.testo,
      lingua: s.lingua ?? null,
      origine: "ai",
      quando: s.generatoIl,
      rif: {
        recuperatoDa: "ai_suggerimenti",
        modello: s.modello,
        esempiUsati: s.esempiUsati ?? null,
      },
    });
  }

  // — registro_attivita: i ritagli delle approvazioni sovrascritte -----------
  type DocAtt = {
    oggettoId?: string | null;
    dettaglio?: string;
    quando?: Date;
    operatoreId?: number;
  };
  const righeAttivita = await d
    .collection<DocAtt>("registro_attivita")
    .find({ azione: "pubblicazione.approvata" })
    .toArray();
  for (const a of righeAttivita) {
    const chiave = a.oggettoId ?? "";
    if (!viva(chiave)) {
      if (chiave) orfane.attivita += 1;
      continue;
    }
    const m = a.dettaglio?.match(/«([\s\S]*)»\s*$/);
    const testo = m?.[1]?.trim();
    if (!testo) continue;
    voci.push({
      recensioneChiave: chiave,
      tipo: "inviata",
      testo,
      origine: a.operatoreId === OPERATORE_SISTEMA ? "pilota" : "operatore",
      operatoreId: a.operatoreId,
      modo: "reale",
      troncato: testo.length >= TAGLIO_ATTIVITA,
      quando: a.quando,
      rif: { recuperatoDa: "registro_attivita" },
    });
  }

  // — riepilogo e scrittura --------------------------------------------------
  const perTipo: Record<string, number> = {};
  const perFonte: Record<string, number> = {};
  let tagliate = 0;
  for (const v of voci) {
    perTipo[v.tipo] = (perTipo[v.tipo] ?? 0) + 1;
    const f = v.rif?.recuperatoDa ?? "?";
    perFonte[f] = (perFonte[f] ?? 0) + 1;
    if (v.troncato) tagliate += 1;
  }

  // Il numero che conta: quante recensioni avranno sia una proposta sia un
  // testo inviato, e i due DIVERSI fra loro. Non è il totale delle versioni —
  // è il materiale su cui si potrà tarare il modello.
  const proposteDi = new Map<string, Set<string>>();
  const inviateDi = new Map<string, Set<string>>();
  for (const v of voci) {
    if (v.troncato) continue;
    const dove =
      v.tipo === "inviata" ? inviateDi : v.tipo.startsWith("proposta") ? proposteDi : null;
    if (!dove) continue;
    const s = dove.get(v.recensioneChiave) ?? new Set<string>();
    s.add(v.testo.trim());
    dove.set(v.recensioneChiave, s);
  }
  let coppie = 0;
  for (const [chiave, proposte] of proposteDi) {
    const inviate = inviateDi.get(chiave);
    if (!inviate) continue;
    // Almeno una coppia in cui i testi differiscono: se coincidono, la persona
    // ha accettato la proposta e non c'è nessuna correzione da imparare.
    if ([...proposte].some((p) => [...inviate].some((i) => i !== p))) coppie += 1;
  }

  console.log(`\nVersioni ripescate: ${voci.length} (di cui ${tagliate} tagliate)`);
  console.log(`Recensioni con una correzione ricostruibile: ${coppie}`);
  console.log("\n  per fonte");
  for (const [k, n] of Object.entries(perFonte).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k.padEnd(20)} ${n}`);
  }
  console.log("\n  per tipo");
  for (const [k, n] of Object.entries(perTipo).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k.padEnd(20)} ${n}`);
  }
  const perse = Object.values(orfane).reduce((s, n) => s + n, 0);
  if (perse > 0) {
    console.log(`\n  scartate perché la recensione non è in archivio: ${perse}`);
    for (const [k, n] of Object.entries(orfane)) if (n > 0) console.log(`    ${k.padEnd(20)} ${n}`);
  }

  if (!scrivi) {
    console.log("\nProva a vuoto: non ho scritto niente. Rilancia con --scrivi.\n");
    await (await mongo()).close();
    return;
  }

  // A lotti: un insertMany da decine di migliaia di documenti è un pacchetto
  // solo, e su Atlas è il modo più rapido di prendersi un timeout.
  const LOTTO = 500;
  let entrate = 0;
  for (let i = 0; i < voci.length; i += LOTTO) {
    entrate += await registraVersioni(voci.slice(i, i + LOTTO));
    process.stdout.write(`\r  scritte ${Math.min(i + LOTTO, voci.length)}/${voci.length}…`);
  }
  console.log(
    `\n\nEntrate ${entrate} versioni nuove; ${voci.length - entrate} erano già nello storico.`,
  );
  console.log("\nStorico adesso:", await contaStorico(), "\n");

  await (await mongo()).close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
