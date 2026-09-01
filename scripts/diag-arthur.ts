import { readFileSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Diagnostica: perché una recensione NON compare in «Da approvare»?
// SOLA LETTURA (una guardia blocca ogni fetch non-GET). Carica le email come
// fa l'app, isola il thread del cliente cercato e dice, con i dati veri:
//   - se il cliente è dentro la finestra di 50 messaggi che l'app carica;
//   - quali flag ha (risolto, haRisposta) e da quale email nascono;
//   - se la sua chiave è già "pubblicata" o "archiviata" (Mongo).
//
//   npm run diag:arthur -- "Arthur"        (default: "arthur")
//   npm run diag:arthur -- "Lavallée"
// ---------------------------------------------------------------------------

function loadEnv() {
  const txt = readFileSync(path.join(process.cwd(), ".env"), "utf8");
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnv();

// Guardia sola-lettura: ogni scrittura via fetch (tranne il token) è vietata.
const fetchVero = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = typeof input === "string" ? input : ((input as Request).url ?? String(input));
  const metodo = (init?.method ?? "GET").toUpperCase();
  const soloToken = /login\.microsoftonline\.com/.test(url);
  if (metodo !== "GET" && !soloToken) throw new Error(`SCRITTURA BLOCCATA: ${metodo} ${url}`);
  return fetchVero(input, init);
}) as typeof fetch;

function tronca(s: string, n: number): string {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

async function main() {
  const cerca = (process.argv.slice(2).join(" ").trim() || "arthur").toLowerCase();

  const { loadSettings, activeMailbox } = await import("@/server/settings");
  const { searchMessages } = await import("@/server/graph/client");
  const { parseReview, htmlToText } = await import("@/server/reviews/parse");
  const { chiaviPubblicate } = await import("@/server/db/pubblicazioni");
  const { chiaviArchiviate } = await import("@/server/db/recensioni");

  const settings = await loadSettings();
  const label = settings.labels[0];
  if (!label) {
    console.log("Nessuna label configurata in Impostazioni.");
    process.exit(1);
  }
  console.log(`Cerco «${cerca}» · label subjectContains=«${label.subjectContains}»\n`);

  // Scarico un po' più larga della finestra dell'app (50) per vedere se il
  // cliente è appena FUORI da quella finestra.
  const LARGO = 200;
  const messaggi = await searchMessages({
    subjectContains: label.subjectContains,
    fromContains: label.fromContains,
    top: LARGO,
    mailbox: await activeMailbox(),
  });
  console.log(`Messaggi che l'app potrebbe vedere (fino a ${LARGO}): ${messaggi.length}`);
  console.log(`Finestra REALE dell'app: primi 50 messaggi.\n`);

  // Testo di un messaggio (per cercarci dentro il nome).
  const testoDi = (m: (typeof messaggi)[number]) =>
    (m.bodyIsHtml ? htmlToText(m.bodyContent) : m.bodyContent) || "";

  // Indice (posizione nella lista ordinata desc) del PRIMO messaggio che
  // menziona il cliente: se ≥ 50, l'app non lo carica proprio.
  const idxMatch = messaggi.findIndex(
    (m) =>
      m.subject.toLowerCase().includes(cerca) ||
      m.fromAddress.toLowerCase().includes(cerca) ||
      testoDi(m).toLowerCase().includes(cerca),
  );

  if (idxMatch < 0) {
    console.log(
      `❌ «${cerca}» NON compare in nessuno dei primi ${messaggi.length} messaggi. ` +
        `La recensione è più vecchia della finestra: l'app non la carica affatto.`,
    );
    process.exit(0);
  }

  console.log(
    `Prima menzione di «${cerca}»: messaggio #${idxMatch + 1} su ${messaggi.length} ` +
      `→ ${idxMatch < 50 ? "DENTRO" : "FUORI"} la finestra dei 50 dell'app.\n`,
  );

  // Raggruppo per conversazione e isolo i gruppi che menzionano il cliente.
  const perConv = new Map<string, typeof messaggi>();
  for (const m of messaggi) {
    const k = m.conversationId || m.id;
    (perConv.get(k) ?? perConv.set(k, []).get(k)!).push(m);
  }

  const gruppiMatch = [...perConv.entries()].filter(([, g]) =>
    g.some(
      (m) =>
        m.subject.toLowerCase().includes(cerca) ||
        m.fromAddress.toLowerCase().includes(cerca) ||
        testoDi(m).toLowerCase().includes(cerca),
    ),
  );

  const pubblicate = await chiaviPubblicate().catch(() => new Set<string>());
  const archiviate = await chiaviArchiviate().catch(() => new Set<string>());

  for (const [chiave, gruppo] of gruppiMatch) {
    gruppo.sort(
      (a, b) => new Date(a.receivedDateTime).getTime() - new Date(b.receivedDateTime).getTime(),
    );
    // Nome/stelle dal messaggio Zapier (o dal primo interpretabile).
    let nome = "?";
    let stelle: number | null = null;
    for (const m of gruppo) {
      const p = parseReview(testoDi(m));
      if (p) {
        nome = p.name || nome;
        stelle = p.score;
        if (m.fromAddress.toLowerCase().includes("zapier")) break;
      }
    }

    const risolto = gruppo.some((m) => /ticket\s+risolto/i.test(m.subject));
    const haRisposta = gruppo.some((m) => {
      const a = m.fromAddress.toLowerCase();
      return a.endsWith("@galdierirent.it") && !a.startsWith("customer.care") && !a.includes("zapier");
    });

    console.log("─".repeat(72));
    console.log(`Conversazione: ${chiave}`);
    console.log(`Recensore: «${nome}» · stelle: ${stelle ?? "—"} · messaggi: ${gruppo.length}`);
    console.log("Thread (dal più vecchio):");
    for (const m of gruppo) {
      const segnaR = /ticket\s+risolto/i.test(m.subject) ? "  ⟵ risolto(subject)" : "";
      const a = m.fromAddress.toLowerCase();
      const segnaH =
        a.endsWith("@galdierirent.it") && !a.startsWith("customer.care") && !a.includes("zapier")
          ? "  ⟵ haRisposta(mittente)"
          : "";
      console.log(
        `  ${m.receivedDateTime}  ${tronca(m.fromAddress, 34).padEnd(34)}  ${tronca(m.subject, 46)}${segnaR}${segnaH}`,
      );
    }
    console.log("\nEsito FILTRI di «Da approvare»:");
    console.log(`  pubblicate?   ${pubblicate.has(chiave) ? "SÌ → nascosta" : "no"}`);
    console.log(`  archiviata?   ${archiviate.has(chiave) ? "SÌ → nascosta" : "no"}`);
    console.log(`  haRisposta?   ${haRisposta ? "SÌ → NASCOSTA (mittente @galdierirent.it nel thread)" : "no"}`);
    console.log(`  risolto?      ${risolto ? "sì (ma NON nasconde più, dopo il fix)" : "no"}`);
    const nascosta = pubblicate.has(chiave) || archiviate.has(chiave) || haRisposta;
    console.log(`\n→ ${nascosta ? "NASCOSTA" : "DOVREBBE COMPARIRE"} in «Da approvare».`);
  }

  console.log("─".repeat(72));
  process.exit(0);
}

main().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
