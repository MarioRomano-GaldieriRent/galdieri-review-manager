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

/** Come apre la risposta: appellativo usato. */
function apertura(r: string, italiano: boolean): string {
  const t = r.trim();
  if (italiano) {
    if (/^gentile\s+(sig\.?\s*ra\b|signora\b)/i.test(t)) return "Gentile signora <cognome>";
    if (/^gentile\s+(sig\.?\b|signor[e]?\b)/i.test(t)) return "Gentile signor <cognome>";
    if (/^gentile\b/i.test(t)) return "Gentile <nome, senza appellativo>";
    if (/^(buongiorno|buonasera|salve|ciao)\b/i.test(t)) return "saluto (Buongiorno/Salve…)";
    return "nessun appellativo";
  }
  if (/^dear\s+(mrs|ms|miss)\b/i.test(t)) return "Dear Mrs <cognome>";
  if (/^dear\s+mr\b/i.test(t)) return "Dear Mr <cognome>";
  if (/^dear\b/i.test(t)) return "Dear <nome, senza appellativo>";
  if (/^(hello|hi|good morning)\b/i.test(t)) return "saluto (Hello/Hi…)";
  return "nessun appellativo";
}

/** Come chiude. */
function chiusura(r: string): string {
  const t = r.trim().replace(/\s+/g, " ");
  if (/a presto[.!]?$/i.test(t)) return "A presto.";
  if (/see you soon[.!]?$/i.test(t)) return "See you soon.";
  if (/(cordiali saluti|un cordiale saluto)[.!]?$/i.test(t)) return "Cordiali saluti.";
  if (/(best regards|kind regards|regards)[.!]?$/i.test(t)) return "Best regards.";
  if (/(grazie|thank you|thanks)[.!]?$/i.test(t)) return "…grazie / thank you";
  return "altro";
}

const percentile = (ordinati: number[], p: number) =>
  ordinati.length === 0
    ? 0
    : ordinati[Math.min(ordinati.length - 1, Math.floor((ordinati.length - 1) * p))];

/** Stile: quanto scrive e come apre/chiude. Serve a tarare il prompt dell'AI. */
function analizzaStile(nome: string, voci: Voce[], italiano: boolean) {
  if (voci.length === 0) return;
  const lung = voci.map((v) => v.risposta.trim().length).sort((a, b) => a - b);
  const media = Math.round(lung.reduce((s, n) => s + n, 0) / lung.length);

  const fasce = { "≤80": 0, "81-120": 0, "121-160": 0, "161-200": 0, ">200": 0 };
  for (const l of lung) {
    if (l <= 80) fasce["≤80"]++;
    else if (l <= 120) fasce["81-120"]++;
    else if (l <= 160) fasce["121-160"]++;
    else if (l <= 200) fasce["161-200"]++;
    else fasce[">200"]++;
  }

  const ap = new Map<string, number>();
  const ch = new Map<string, number>();
  for (const v of voci) {
    const a = apertura(v.risposta, italiano);
    ap.set(a, (ap.get(a) ?? 0) + 1);
    const c = chiusura(v.risposta);
    ch.set(c, (ch.get(c) ?? 0) + 1);
  }

  // Nomi "ambigui": una sola parola (niente cognome) — è il caso in cui l'AI
  // non sa dedurre il genere. Cosa fa Stefania in quei casi?
  const ambigui = voci.filter((v) => v.nomeCliente.trim().split(/\s+/).length === 1);
  const apAmbigui = new Map<string, number>();
  for (const v of ambigui) {
    const a = apertura(v.risposta, italiano);
    apAmbigui.set(a, (apAmbigui.get(a) ?? 0) + 1);
  }

  console.log(`\n${"=".repeat(78)}`);
  console.log(`STILE · ${nome}  —  ${voci.length} risposte di Stefania`);
  console.log("=".repeat(78));
  console.log(
    `Lunghezza (caratteri): mediana ${percentile(lung, 0.5)} · media ${media} · ` +
      `p25 ${percentile(lung, 0.25)} · p75 ${percentile(lung, 0.75)} · p90 ${percentile(lung, 0.9)} · max ${lung[lung.length - 1]}`,
  );
  console.log(
    "  " +
      Object.entries(fasce)
        .map(([k, n]) => `${k}: ${pct(n, voci.length)}`)
        .join("  ·  "),
  );
  console.log("Apertura:");
  for (const [k, n] of [...ap.entries()].sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(n).padStart(5)}  ${pct(n, voci.length).padStart(4)}  ${k}`);
  console.log("Chiusura:");
  for (const [k, n] of [...ch.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5))
    console.log(`  ${String(n).padStart(5)}  ${pct(n, voci.length).padStart(4)}  ${k}`);
  console.log(`Nomi di UNA sola parola (genere non deducibile): ${ambigui.length}`);
  for (const [k, n] of [...apAmbigui.entries()].sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(n).padStart(5)}  ${pct(n, ambigui.length).padStart(4)}  ${k}`);
  if (ambigui.length > 0) {
    console.log("  esempi:");
    for (const v of ambigui.slice(0, 4))
      console.log(`     «${v.nomeCliente}» → ${taglia(v.risposta, 90)}`);
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

  // Stile delle positive con commento: è su queste che l'AI deve tarare
  // lunghezza, apertura e chiusura.
  for (const lingua of ["it", "en"]) {
    const voci = soloStefania.filter((v) => v.tipo === "positiva-con-testo" && v.lingua === lingua);
    analizzaStile(`positiva-con-testo · ${lingua}`, voci, lingua === "it");
  }

  process.exit(0);
}

main().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
