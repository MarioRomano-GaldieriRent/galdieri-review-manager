import { readFileSync } from "node:fs";
import path from "node:path";

// Chiude i TICKET GEMELLI rimasti aperti: due ticket nati dalla stessa email,
// il portale ne ha chiuso uno e l'altro è rimasto in coda al customer care.
//
// È il recupero una tantum di quelli già accumulati; d'ora in poi li chiude da
// sé la chiusura normale (freshdeskChiusura.ts). Si può rilanciare quando
// serve: guarda solo la finestra dei ticket recenti e tocca solo ciò che trova
// ancora aperto.
//
// COSA TOCCA, e solo questo:
//   - oggetto uguale e nascita nello stesso istante (max 10 secondi);
//   - l'oggetto parla di recensioni (gli altri doppioni non sono affar nostro);
//   - il gemello è ancora Aperto o In attesa e non ha mai avuto un tipo;
//   - l'altro della coppia risulta già Risolto o Chiuso.
// Al gemello mette stato Risolto, il tag «caso_sdoppiato» e una nota privata
// che rimanda al ticket vero. Nessuna classificazione: la recensione è una
// sola e contarla due volte falserebbe i rapporti.
//
//   npm run chiudi:doppioni            → PROVA, non scrive
//   npm run chiudi:doppioni -- --scrivi

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

const ENTRO_MS = 10_000;
const APERTI = [2, 3];
const CHIUSI = [4, 5];
const ORA = new Intl.DateTimeFormat("it-IT", {
  timeZone: "Europe/Rome",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

async function main() {
  const scrivi = process.argv.includes("--scrivi");
  const { elencoTicketRecenti, STATO } = await import("@/server/integrations/freshdesk");
  const { chiudiDoppioniRimasti } = await import("@/server/integrations/freshdeskChiusura");

  const recenti = await elencoTicketRecenti(6, true);
  console.log(`Letti ${recenti.length} ticket recenti.\n`);

  // Le coppie: stesso oggetto, nate nello stesso istante.
  const per = new Map<string, typeof recenti>();
  for (const t of recenti) {
    const k = t.subject.trim().toLowerCase();
    const a = per.get(k);
    if (a) a.push(t);
    else per.set(k, [t]);
  }

  const daChiudere: { gemello: (typeof recenti)[number]; originale: (typeof recenti)[number] }[] = [];
  for (const gruppo of per.values()) {
    if (gruppo.length < 2) continue;
    if (!/recension/i.test(gruppo[0].subject)) continue; // solo le recensioni
    gruppo.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    for (let i = 1; i < gruppo.length; i++) {
      const a = gruppo[i - 1];
      const b = gruppo[i];
      if (new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() > ENTRO_MS) continue;
      const aperto = [a, b].find((t) => APERTI.includes(t.status) && !t.type);
      const chiuso = [a, b].find((t) => CHIUSI.includes(t.status));
      if (aperto && chiuso) daChiudere.push({ gemello: aperto, originale: chiuso });
    }
  }

  if (daChiudere.length === 0) {
    console.log("Nessun doppione rimasto aperto. Niente da fare.");
    process.exit(0);
  }

  console.log(`Doppioni rimasti aperti: ${daChiudere.length}`);
  for (const { gemello, originale } of daChiudere) {
    console.log(
      `  #${gemello.id} (${STATO[gemello.status] ?? gemello.status}) ← doppione di #${originale.id} (${STATO[originale.status] ?? originale.status}) · ${ORA.format(new Date(gemello.createdAt))}`,
    );
    console.log(`      «${gemello.subject}»`);
  }

  if (!scrivi) {
    console.log("\n[PROVA] Niente scritto. Rilancia con --scrivi.");
    process.exit(0);
  }

  console.log("");
  for (const esito of await chiudiDoppioniRimasti(daChiudere.map((x) => ({ gemelloId: x.gemello.id, originaleId: x.originale.id })))) {
    console.log(`  ${esito}`);
  }
  console.log("\n✅ Fatto.");
  process.exit(0);
}

main().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
