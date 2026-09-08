import { readFileSync } from "node:fs";
import path from "node:path";

// Prova dal vivo il riconoscimento IA del nome: UNA chiamata a Claude (se
// configurato) più una lettura/scrittura sulla cache lingua_nomi. Nessun
// effetto su recensioni o pubblicazioni.
//
//   npm run diag:lingua-nome -- "Mario Rossi"
//   npm run diag:lingua-nome -- "Mario Rossi" "John Smith" "Carlos Garcia"

function loadEnv() {
  const txt = readFileSync(path.join(process.cwd(), ".env"), "utf8");
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnv();

async function main() {
  const nomi = process.argv.slice(2);
  if (nomi.length === 0) {
    console.log('Uso: npm run diag:lingua-nome -- "Mario Rossi" ["altro nome" ...]');
    process.exit(1);
  }

  const { isClaudeConfigured } = await import("@/server/ai/claude");
  const { linguaDalNomeIA } = await import("@/server/reviews/linguaNomeAI");
  const { nomeSembraItaliano } = await import("@/server/reviews/lingua");
  const { leggiLinguaNome } = await import("@/server/db/linguaNomi");

  console.log(`Claude configurato: ${isClaudeConfigured() ? "sì" : "NO — si usa solo l'euristica"}`);
  console.log("");

  for (const nome of nomi) {
    const primaInCache = await leggiLinguaNome(nome);
    const inizio = Date.now();
    const esito = await linguaDalNomeIA(nome);
    const ms = Date.now() - inizio;
    const euristica = nomeSembraItaliano(nome) ? "it" : "altra";
    console.log(
      `«${nome}» → ${esito}${esito === "it" ? " (italiano)" : " (straniero → inglese)"}` +
        ` — ${primaInCache ? "dalla CACHE" : ms < 50 ? "risposta immediata (cache/euristica)" : `IA in ${ms}ms`}` +
        (euristica !== esito ? ` [l'euristica da sola avrebbe detto «${euristica}»]` : ""),
    );
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
