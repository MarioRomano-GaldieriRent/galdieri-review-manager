import { readFileSync } from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Analisi storica delle recensioni arrivate sulla casella monitorata.
//
// SOLA LETTURA. Come per test-automazioni, il fetch globale è sostituito da un
// guardiano che solleva un errore a ogni richiesta diversa da GET: questo
// script non può modificare nulla, nemmeno per sbaglio.
//
//   npm run analisi -- [mesi]      (default 5)
// ---------------------------------------------------------------------------

function loadEnv() {
  const txt = readFileSync(path.join(process.cwd(), ".env"), "utf8");
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (!v.startsWith('"') && !v.startsWith("'")) {
      const c = v.indexOf(" #");
      if (c >= 0) v = v.slice(0, c).trim();
    }
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnv();

let letture = 0;
const fetchVero = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = typeof input === "string" ? input : ((input as Request).url ?? String(input));
  const metodo = (init?.method ?? "GET").toUpperCase();
  const soloToken = /login\.microsoftonline\.com/.test(url);
  if (metodo !== "GET" && !soloToken) {
    throw new Error(`SCRITTURA BLOCCATA: ${metodo} ${url}`);
  }
  if (metodo === "GET") letture++;
  return fetchVero(input, init);
}) as typeof fetch;

type Msg = {
  id: string;
  conversationId: string;
  subject: string;
  receivedDateTime: string;
  from?: { emailAddress?: { address?: string } };
  body?: { content?: string; contentType?: string };
};

/** Esegue i lavori a gruppi, per non sommergere Graph di richieste. */
async function aGruppi<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += n) {
    out.push(...(await Promise.all(items.slice(i, i + n).map(fn))));
    process.stdout.write(`\r  scaricati ${Math.min(i + n, items.length)}/${items.length}   `);
  }
  process.stdout.write("\r" + " ".repeat(40) + "\r");
  return out;
}

/** Settimana ISO come "2026-W12", con il lunedì come primo giorno. */
function settimana(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const inizioAnno = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const n = Math.ceil(((t.getTime() - inizioAnno.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(n).padStart(2, "0")}`;
}

async function main() {
  const mesi = Number(process.argv[2]) || 5;
  const { activeMailbox, resolveGraph } = await import("@/server/settings");
  const { htmlToText, parseReview, splitTranslation, locationFromSubject } = await import(
    "@/server/reviews/parse"
  );

  const cfg = await resolveGraph();
  const mailbox = await activeMailbox();

  // Token (POST consentita: non modifica nulla).
  const tk = await fetchVero(
    `https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
    },
  );
  const token = ((await tk.json()) as { access_token: string }).access_token;
  const H = { Authorization: `Bearer ${token}` };
  const base = `${cfg.graphUrl}/users/${encodeURIComponent(mailbox)}`;

  const da = new Date();
  da.setMonth(da.getMonth() - mesi);
  const daISO = da.toISOString();

  console.log(`Casella:   ${mailbox}`);
  console.log(`Periodo:   dal ${daISO.slice(0, 10)} a oggi (${mesi} mesi)\n`);

  // --- Passo 1: elenco leggero di TUTTA la posta del periodo (senza corpi).
  console.log("Passo 1 — scansione della posta del periodo…");
  let url =
    `${base}/messages?$filter=receivedDateTime ge ${daISO}` +
    `&$select=id,conversationId,subject,receivedDateTime,from` +
    `&$orderby=receivedDateTime desc&$top=999`;
  const tutti: Msg[] = [];
  while (url) {
    const res = await fetch(url, { headers: H, cache: "no-store" });
    if (!res.ok) throw new Error(`Graph ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { value: Msg[]; "@odata.nextLink"?: string };
    tutti.push(...j.value);
    process.stdout.write(`\r  ${tutti.length} email lette   `);
    url = j["@odata.nextLink"] ?? "";
  }
  console.log(`\r  ${tutti.length} email totali nel periodo.\n`);

  // --- Passo 2: solo le email che contengono davvero i dati di una recensione.
  // Sono quelle inviate da Zapier: le altre del flusso (notifiche Freshdesk,
  // inoltri) citano la recensione ma non hanno i campi.
  const candidate = tutti.filter(
    (m) =>
      /recensione/i.test(m.subject ?? "") &&
      /zapier/i.test(m.from?.emailAddress?.address ?? ""),
  );

  // Una sola email per conversazione: la più vecchia, cioè l'originale.
  const perConversazione = new Map<string, Msg>();
  for (const m of candidate) {
    const k = m.conversationId || m.id;
    const p = perConversazione.get(k);
    if (!p || new Date(m.receivedDateTime) < new Date(p.receivedDateTime)) {
      perConversazione.set(k, m);
    }
  }
  const daScaricare = [...perConversazione.values()];
  console.log(
    `Passo 2 — ${candidate.length} email di recensione da Zapier, ` +
      `${daScaricare.length} conversazioni distinte. Scarico i testi…`,
  );

  // Graph limita le richieste: senza gestire il 429 si perdono silenziosamente
  // dei messaggi, e l'analisi risulterebbe monca senza dirlo.
  const problemi = new Map<string, number>();
  let corpiVuoti = 0;

  const conCorpo = await aGruppi(daScaricare, 6, async (m) => {
    for (let tentativo = 0; tentativo < 6; tentativo++) {
      const r = await fetch(
        `${base}/messages/${encodeURIComponent(m.id)}?$select=subject,body,receivedDateTime`,
        { headers: H, cache: "no-store" },
      );
      if (r.status === 429 || r.status === 503) {
        const attesa = Number(r.headers.get("Retry-After") ?? "") || 2 ** tentativo;
        await new Promise((ok) => setTimeout(ok, attesa * 1000));
        continue;
      }
      if (!r.ok) {
        problemi.set(String(r.status), (problemi.get(String(r.status)) ?? 0) + 1);
        return null;
      }
      const d = (await r.json()) as Msg;
      if (!d.body?.content) corpiVuoti++;
      return { ...m, body: d.body };
    }
    problemi.set("429 dopo 6 tentativi", (problemi.get("429 dopo 6 tentativi") ?? 0) + 1);
    return null;
  });

  const scaricati = conCorpo.filter(Boolean).length;
  console.log(`  ${scaricati}/${daScaricare.length} testi scaricati.`);
  if (problemi.size) {
    console.log(
      `  ATTENZIONE, messaggi persi: ${[...problemi].map(([k, v]) => `${v}× ${k}`).join(", ")}`,
    );
  }
  if (corpiVuoti) console.log(`  ${corpiVuoti} messaggi senza corpo.`);

  // --- Passo 3: classificazione.
  type Riga = { data: Date; stelle: number | null; conTesto: boolean; sede: string };
  const righe: Riga[] = [];
  let nonInterpretabili = 0;

  for (const m of conCorpo) {
    if (!m?.body?.content) continue;
    const testo =
      m.body.contentType?.toLowerCase() === "html"
        ? htmlToText(m.body.content)
        : m.body.content;
    const p = parseReview(testo);
    if (!p) {
      nonInterpretabili++;
      continue;
    }
    const parti = splitTranslation(p.comment);
    const commento = (parti.original || parti.translated).trim();
    righe.push({
      data: new Date(m.receivedDateTime),
      stelle: p.score,
      conTesto: commento.length > 0,
      sede: locationFromSubject(m.subject, "RECENSIONE GOOGLE"),
    });
  }

  // ------------------------------------------------------------- risultati
  const tot = righe.length;
  const perStelle: Record<string, number> = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0, "?": 0 };
  for (const r of righe) perStelle[r.stelle ? String(r.stelle) : "?"]++;

  const cinqueSenza = righe.filter((r) => r.stelle === 5 && !r.conTesto);
  const cinqueCon = righe.filter((r) => r.stelle === 5 && r.conTesto);
  const negative = righe.filter((r) => r.stelle === 1 || r.stelle === 2);

  const date = righe.map((r) => r.data.getTime());
  const giorni = (Math.max(...date) - Math.min(...date)) / 86400000;
  const settimane = Math.max(1, giorni / 7);

  const pct = (n: number) => ((n / tot) * 100).toFixed(1).padStart(5) + "%";
  const set = (n: number) => (n / settimane).toFixed(1).padStart(5);

  console.log("\n" + "=".repeat(72));
  console.log(`RECENSIONI INTERPRETATE: ${tot}   (${settimane.toFixed(1)} settimane di dati)`);
  console.log(
    `Copertura: ${tot}/${daScaricare.length} conversazioni ` +
      `(${((tot / daScaricare.length) * 100).toFixed(1)}%)`,
  );
  if (nonInterpretabili) console.log(`Email non interpretabili: ${nonInterpretabili}`);
  console.log("=".repeat(72));

  console.log("\nDISTRIBUZIONE PER PUNTEGGIO");
  for (const s of ["5", "4", "3", "2", "1", "?"]) {
    const n = perStelle[s];
    if (!n && s === "?") continue;
    const barra = "█".repeat(Math.round((n / tot) * 50));
    console.log(`  ${s === "?" ? "n/d" : s + "★ "} ${String(n).padStart(4)}  ${pct(n)}  ${barra}`);
  }

  console.log("\nI DUE CASI CHE INTERESSANO");
  console.log(`  ${"".padEnd(30)} ${"totale".padStart(6)} ${"quota".padStart(6)} ${"a settimana".padStart(11)}`);
  console.log(`  ${"-".repeat(30)} ${"-".repeat(6)} ${"-".repeat(6)} ${"-".repeat(11)}`);
  console.log(`  ${"5 stelle SENZA commento".padEnd(30)} ${String(cinqueSenza.length).padStart(6)} ${pct(cinqueSenza.length)} ${set(cinqueSenza.length)}`);
  console.log(`  ${"5 stelle con commento".padEnd(30)} ${String(cinqueCon.length).padStart(6)} ${pct(cinqueCon.length)} ${set(cinqueCon.length)}`);
  console.log(`  ${"1 e 2 stelle".padEnd(30)} ${String(negative.length).padStart(6)} ${pct(negative.length)} ${set(negative.length)}`);
  console.log(`  ${"tutte le recensioni".padEnd(30)} ${String(tot).padStart(6)} ${pct(tot)} ${set(tot)}`);

  // Andamento settimanale
  const perSettimana = new Map<string, { tot: number; cinqueSenza: number; neg: number }>();
  for (const r of righe) {
    const k = settimana(r.data);
    const v = perSettimana.get(k) ?? { tot: 0, cinqueSenza: 0, neg: 0 };
    v.tot++;
    if (r.stelle === 5 && !r.conTesto) v.cinqueSenza++;
    if (r.stelle === 1 || r.stelle === 2) v.neg++;
    perSettimana.set(k, v);
  }

  console.log("\nANDAMENTO SETTIMANALE");
  console.log(`  settimana   totale   5★ senza   1-2★`);
  console.log(`  ${"-".repeat(9)}   ${"-".repeat(6)}   ${"-".repeat(8)}   ${"-".repeat(4)}`);
  const chiavi = [...perSettimana.keys()].sort();
  for (const k of chiavi) {
    const v = perSettimana.get(k)!;
    console.log(
      `  ${k}   ${String(v.tot).padStart(6)}   ${String(v.cinqueSenza).padStart(8)}   ${String(v.neg).padStart(4)}`,
    );
  }
  const medie = chiavi.map((k) => perSettimana.get(k)!);
  const complete = medie.slice(1, -1); // la prima e l'ultima settimana sono parziali
  if (complete.length >= 2) {
    const m = (f: (v: (typeof complete)[0]) => number) =>
      (complete.reduce((s, v) => s + f(v), 0) / complete.length).toFixed(1);
    console.log(`\n  media su ${complete.length} settimane intere (escluse prima e ultima, parziali):`);
    console.log(`    totale ${m((v) => v.tot)} · 5★ senza commento ${m((v) => v.cinqueSenza)} · 1-2★ ${m((v) => v.neg)}`);
  }

  console.log(`\nRichieste HTTP di lettura: ${letture}. Scritture: 0 (bloccate per costruzione).`);
}

main().catch((e) => {
  console.error("\nERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
