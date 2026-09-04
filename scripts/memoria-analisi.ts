import { readFileSync } from "node:fs";
import path from "node:path";

// ANALISI della memoria: dove Stefania scrive DAVVERO su misura e dove ripete
// un template. Serve a decidere su quali categorie ha senso il suggerimento AI.
// SOLA LETTURA.
//   npm run memoria:analisi

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

type Voce = {
  tipo: string;
  lingua: string;
  origine: string;
  stelle: number | null;
  nomeCliente: string;
  commento: string;
  risposta: string;
};

/**
 * Forma "scheletro" della risposta: toglie ciò che cambia sempre (il nome del
 * cliente, l'appellativo, punteggiatura, maiuscole). Due risposte con lo stesso
 * scheletro sono LO STESSO template riusato.
 */
function scheletro(r: string, nome: string): string {
  let s = ` ${r.toLowerCase().replace(/\s+/g, " ")} `;
  // via il nome del cliente e le sue parole (spesso citato come "signor X")
  for (const p of nome
    .toLowerCase()
    .split(/\s+/)
    .filter((x) => x.length > 2)) {
    s = s.split(p).join(" ");
  }
  s = s
    .replace(/\b(gentile|caro|cara|dear)\b[^,]{0,40},/g, " ") // "Gentile signor …,"
    .replace(/\b(sig\.?ra?|signor[ae]?|mr|mrs|ms|miss)\b/g, " ")
    .replace(/[^\p{L}\s]/gu, " ") // via punteggiatura e cifre
    .replace(/\s+/g, " ")
    .trim();
  return s;
}

/** Parole "di contenuto" del commento riprese nella risposta: segno di personalizzazione vera. */
const STOP = new Set(
  (
    "il lo la i gli le un uno una di a da in con su per tra fra e o ma che non è era sono ho ha " +
    "abbiamo hanno molto più anche come si mi ci ne al del dal nel col alla della dalla nella " +
    "the a an of to in on for with and or but that is was are have has we i you they it very " +
    "my our your this at be been were not so all no"
  ).split(" "),
);
function parolePiene(t: string): Set<string> {
  return new Set(
    t
      .toLowerCase()
      .replace(/[^\p{L}\s]/gu, " ")
      .split(/\s+/)
      .filter((p) => p.length > 4 && !STOP.has(p)),
  );
}

const pct = (n: number, d: number) => (d === 0 ? "—" : `${Math.round((n / d) * 100)}%`);
const taglia = (s: string, n: number) =>
  (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\s+/g, " ");

function analizza(nome: string, voci: Voce[]) {
  if (voci.length === 0) return;
  const conteggio = new Map<string, { n: number; esempio: string }>();
  let lunTot = 0;
  let ripresaTot = 0;
  let conCommento = 0;

  for (const v of voci) {
    const k = scheletro(v.risposta, v.nomeCliente);
    const g = conteggio.get(k);
    if (g) g.n++;
    else conteggio.set(k, { n: 1, esempio: v.risposta });
    lunTot += v.risposta.length;

    if (v.commento.trim()) {
      conCommento++;
      const pc = parolePiene(v.commento);
      const pr = parolePiene(v.risposta);
      let comuni = 0;
      for (const p of pr) if (pc.has(p)) comuni++;
      ripresaTot += pr.size === 0 ? 0 : comuni / pr.size;
    }
  }

  const forme = [...conteggio.values()].sort((a, b) => b.n - a.n);
  const uniche = forme.length;
  const usateUnaVolta = forme.filter((f) => f.n === 1).length;
  // Quante risposte servirebbero per coprire l'80% dei casi con soli template?
  let cum = 0;
  let formePer80 = 0;
  for (const f of forme) {
    cum += f.n;
    formePer80++;
    if (cum >= voci.length * 0.8) break;
  }

  console.log(`\n${"=".repeat(78)}`);
  console.log(`${nome}  —  ${voci.length} risposte`);
  console.log("=".repeat(78));
  console.log(
    `Forme diverse (nome del cliente escluso): ${uniche}  (${pct(uniche, voci.length)} del totale)`,
  );
  console.log(
    `Risposte scritte UNA sola volta (mai riusate): ${usateUnaVolta}  (${pct(usateUnaVolta, voci.length)})`,
  );
  console.log(`Bastano ${formePer80} forme per coprire l'80% dei casi`);
  console.log(`Lunghezza media: ${Math.round(lunTot / voci.length)} caratteri`);
  if (conCommento > 0) {
    console.log(
      `Parole della risposta riprese dal commento del cliente: ${Math.round((ripresaTot / conCommento) * 100)}% in media`,
    );
  }
  console.log(`\nLe 6 formule più ripetute:`);
  for (const f of forme.slice(0, 6)) {
    console.log(`  ${String(f.n).padStart(4)}×  ${taglia(f.esempio, 150)}`);
  }
}

async function main() {
  const { coll } = await import("@/server/db/connessione");
  const c = await coll("memoria_esempi");
  const tutte = (await c.find({ eliminata: false }).toArray()) as unknown as Voce[];

  console.log(`MEMORIA: ${tutte.length} risposte in archivio.`);
  console.log(
    "Domanda: dove Stefania scrive su misura (serve l'AI) e dove ripete (basta un template)?",
  );

  const soloStefania = tutte.filter((v) => v.origine === "stefania");
  console.log(
    `\nDi cui scritte da Stefania: ${soloStefania.length} (le altre sono del customer care)`,
  );

  for (const tipo of ["positiva-con-testo", "positiva-senza-testo", "neutra", "negativa"]) {
    for (const lingua of ["it", "en"]) {
      const voci = soloStefania.filter((v) => v.tipo === tipo && v.lingua === lingua);
      if (voci.length >= 5) analizza(`${tipo} · ${lingua}`, voci);
    }
  }

  process.exit(0);
}

main().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
