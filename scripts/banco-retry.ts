import { readFileSync } from "node:fs";
import path from "node:path";

// BANCO DI PROVA della politica di ritentativi per la chiusura dei ticket
// Freshdesk. Non tocca né Mongo né Freshdesk: `pianoRitentativo` è pura, e
// qui si prova ESATTAMENTE quella che gira in produzione.
//
// Cosa deve garantire (2/11/2026): dopo una risposta pubblicata, il ticket va
// cercato per giorni, non per un quarto d'ora. Il ticket di una recensione lo
// apre il customer care inoltrando a mano la mail di Zapier, e lo fa quando
// può: mediana 34 minuti, ma ventisette casi su settantotto oltre le quattro
// ore e qualcuno il giorno dopo. Con le attese di prima — 2, 4, 8 minuti — la
// voce si arrendeva prima che il ticket esistesse, e la nostra nota non ci
// finiva mai sopra.
//
//   npm run banco:retry

function loadEnv() {
  try {
    const txt = readFileSync(path.join(process.cwd(), ".env"), "utf8");
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
        v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  } catch {
    // Senza .env il banco gira comunque: non si collega a niente.
  }
}
loadEnv();

/** Le attese attese, in minuti, nell'ordine (richiesta di Mario, 2/11/2026). */
const ATTESE = [15, 60, 240, 720, 1440, 2880];

let ko = 0;
function ok(nome: string, cond: boolean, dettaglio = "") {
  if (!cond) ko++;
  console.log(`  ${cond ? "ok  " : "KO  "} ${nome}${dettaglio ? ` — ${dettaglio}` : ""}`);
}

function minutiDaOra(d: Date): number {
  return Math.round((d.getTime() - Date.now()) / 60000);
}

async function main() {
  const { pianoRitentativo, MAX_TENTATIVI_FRESHDESK } = await import("@/server/pubblicazione");

  console.log(`Tentativi massimi: ${MAX_TENTATIVI_FRESHDESK} (attese: ${ATTESE.length})\n`);
  console.log("— le attese, una per fallimento —");

  const attese: number[] = [];
  for (let falliti = 0; falliti < ATTESE.length; falliti++) {
    const p = pianoRitentativo(falliti);
    const minuti = p.prossimoTentativoIl ? minutiDaOra(p.prossimoTentativoIl) : null;
    if (minuti != null) attese.push(minuti);
    // ±1 minuto: fra il calcolo e il confronto passa del tempo reale.
    const giusta = minuti != null && Math.abs(minuti - ATTESE[falliti]) <= 1;
    ok(
      `${falliti + 1}° tentativo fallito → riprova fra ${ATTESE[falliti]} min`,
      giusta && p.esito === "inattesa" && p.tentativi === falliti + 1,
      `esito ${p.esito}, tentativi ${p.tentativi}, fra ${minuti ?? "—"} min`,
    );
  }

  console.log("\n— la resa, e com'è fatta —");
  const resa = pianoRitentativo(ATTESE.length);
  ok(
    "esaurite le attese si molla (e non si riprogramma nulla)",
    resa.esito === "fallito" &&
      resa.prossimoTentativoIl === null &&
      resa.tentativi === ATTESE.length + 1,
    `esito ${resa.esito}, tentativi ${resa.tentativi}, prossimo ${resa.prossimoTentativoIl ?? "null"}`,
  );
  const oltre = pianoRitentativo(99);
  ok(
    "anche con un contatore impazzito resta «fallito», non riparte",
    oltre.esito === "fallito" && oltre.prossimoTentativoIl === null,
    `esito ${oltre.esito}`,
  );

  console.log("\n— la forma della scala —");
  ok(
    "le attese crescono sempre",
    attese.every((v, i) => i === 0 || v > attese[i - 1]),
    attese.join(" → "),
  );
  const totale = attese.reduce((a, b) => a + b, 0);
  ok(
    "la finestra copre più di due giorni",
    totale >= 2 * 24 * 60,
    `${totale} min = ${(totale / 60).toFixed(1)} h = ${(totale / 1440).toFixed(1)} giorni`,
  );
  ok(
    "il primo tentativo NON è più a 2 minuti (era lì il guasto)",
    attese[0] >= 10,
    `primo: ${attese[0]} min`,
  );
  ok(
    "la finestra arriva oltre le 24 ore, per l'inoltro del giorno dopo",
    Math.max(...attese) >= 24 * 60,
    `attesa più lunga: ${Math.max(...attese) / 60} h`,
  );

  console.log(ko === 0 ? "\nTUTTO A POSTO." : `\n${ko} CONTROLLI FALLITI.`);
  process.exit(ko === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
