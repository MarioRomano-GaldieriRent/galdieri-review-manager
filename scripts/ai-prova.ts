import { readFileSync } from "node:fs";
import path from "node:path";

// BANCO DI PROVA della risposta suggerita: prende recensioni VERE già risposte
// da Stefania e mette a confronto la sua risposta con quella generata dall'AI.
// Non pubblica e non scrive nulla: serve solo a giudicare il tono.
//
//   npm run ai:prova              → 6 casi (3 italiani + 3 inglesi)
//   npm run ai:prova -- 10        → 10 per lingua
//   npm run ai:prova -- 6 it      → solo italiani
//
// La recensione in prova viene ESCLUSA dagli esempi passati al modello: altrimenti
// gli si darebbe la soluzione già scritta e il confronto non varrebbe nulla.

function loadEnv() {
  const txt = readFileSync(path.join(process.cwd(), ".env"), "utf8");
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnv();

const avvolgi = (s: string, larghezza = 96, rientro = "     ") => {
  const parole = s.replace(/\s+/g, " ").trim().split(" ");
  const righe: string[] = [];
  let riga = "";
  for (const p of parole) {
    if ((riga + " " + p).trim().length > larghezza) {
      righe.push(riga.trim());
      riga = p;
    } else riga += ` ${p}`;
  }
  if (riga.trim()) righe.push(riga.trim());
  return righe.join(`\n${rientro}`);
};

async function main() {
  const args = process.argv.slice(2);
  const quanti = Number(args.find((a) => /^\d+$/.test(a))) || 3;
  const soloLingua = args.find((a) => a === "it" || a === "en");

  const { coll } = await import("@/server/db/connessione");
  const { generaRispostaSuggerita, ESEMPI_NEL_PROMPT } =
    await import("@/server/ai/rispostaSuggerita");
  const { modelloClaude, isClaudeConfigured } = await import("@/server/ai/claude");

  if (!isClaudeConfigured()) {
    console.error("ANTHROPIC_API_KEY non configurata nel .env.");
    process.exit(1);
  }

  const c = await coll("memoria_esempi");
  const lingue = soloLingua ? [soloLingua] : ["it", "en"];
  console.log(
    `Banco di prova · modello ${modelloClaude()} · ${ESEMPI_NEL_PROMPT} esempi nel contesto\n` +
      `La recensione in prova è esclusa dagli esempi.\n`,
  );

  let costoTotale = 0;
  let n = 0;

  for (const lingua of lingue) {
    // Campione vario: si saltano le risposte troppo corte (poco informative).
    const casi = (await c
      .aggregate([
        {
          $match: {
            eliminata: false,
            tipo: "positiva-con-testo",
            origine: "stefania",
            lingua,
            $expr: { $gt: [{ $strLenCP: "$commento" }, 80] },
          },
        },
        { $sample: { size: quanti } },
      ])
      .toArray()) as unknown as {
      _id: string;
      nomeCliente: string;
      stelle: number | null;
      commento: string;
      sedeNome: string;
      risposta: string;
    }[];

    for (const caso of casi) {
      n++;
      console.log("=".repeat(100));
      console.log(
        `CASO ${n} · ${lingua.toUpperCase()} · ${caso.stelle ?? "—"}★ · ${caso.nomeCliente} · ${caso.sedeNome || "sede n.d."}`,
      );
      console.log("=".repeat(100));
      console.log(`  RECENSIONE\n     ${avvolgi(caso.commento)}\n`);
      console.log(`  STEFANIA (pubblicata davvero)\n     ${avvolgi(caso.risposta)}\n`);
      try {
        const s = await generaRispostaSuggerita(
          {
            nome: caso.nomeCliente,
            stelle: caso.stelle,
            commento: caso.commento,
            sede: caso.sedeNome,
            // lingua rilevata non salvata negli esempi: si lascia decidere all'euristica
          },
          { escludiEsempio: caso._id },
        );
        costoTotale += s.consumo.costo;
        console.log(`  AI (proposta)\n     ${avvolgi(s.testo)}`);
        console.log(
          `     [${s.testo.length} caratteri · ${s.consumo.input} token in, ${s.consumo.cacheLetta} da cache, ${s.consumo.output} out · $${s.consumo.costo.toFixed(4)}]\n`,
        );
      } catch (e) {
        console.log(`  AI: ERRORE — ${e instanceof Error ? e.message : e}\n`);
      }
    }
  }

  console.log("=".repeat(100));
  console.log(
    `${n} casi · costo totale $${costoTotale.toFixed(4)} · media $${(costoTotale / Math.max(1, n)).toFixed(4)} a risposta`,
  );
  console.log(
    `Proiezione su ~200 risposte/mese: circa $${((costoTotale / Math.max(1, n)) * 200).toFixed(2)} al mese.`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
