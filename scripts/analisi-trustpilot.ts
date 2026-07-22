import { readFileSync } from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Analisi storica delle recensioni TRUSTPILOT arrivate sulla casella
// monitorata, e di come vengono lavorate.
//
// SOLA LETTURA. Il fetch globale è sostituito da un guardiano che solleva un
// errore a ogni richiesta diversa da GET: non può modificare nulla.
//
//   npm run analisi:trustpilot -- [mesi]      (default 5)
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

let letture = 0;
const fetchVero = globalThis.fetch;
globalThis.fetch = (async (i: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const metodo = (init?.method ?? "GET").toUpperCase();
  const url = typeof i === "string" ? i : ((i as Request).url ?? String(i));
  if (metodo !== "GET" && !/login\.microsoftonline/.test(url)) {
    throw new Error(`SCRITTURA BLOCCATA: ${metodo} ${url}`);
  }
  if (metodo === "GET") letture++;
  return fetchVero(i, init);
}) as typeof fetch;

type Msg = {
  id: string;
  conversationId?: string;
  subject?: string;
  receivedDateTime: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  toRecipients?: { emailAddress?: { address?: string } }[];
  ccRecipients?: { emailAddress?: { address?: string } }[];
  body?: { content?: string; contentType?: string };
  bodyPreview?: string;
};

const pulisci = (h: string) =>
  (h || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .trim();

const senzaFirma = (s: string) =>
  s.split(/Stefania Maffeo\s*Content Marketing|Content Marketing Specialist/i)[0].trim();

/** Settimana ISO come "2026-W12". */
function settimana(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const inizio = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const n = Math.ceil(((t.getTime() - inizio.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(n).padStart(2, "0")}`;
}

export type RecensioneTP = {
  nome: string;
  stelle: number | null;
  commento: string;
  idRecensione: string;
  sito: string;
  aggiornata: boolean;
};

/**
 * Estrae la recensione dal corpo della notifica Trustpilot.
 *
 * Formato:
 *   <Nome> ha scritto una nuova recensione
 *   Ciao Stefania Maffeo,
 *   <Nome> ha scritto una nuova recensione a <N> stella di <sito>:
 *   <testo>
 *   Leggi la recensione e rispondi
 *   Oppure leggi la recensione sulla tua pagina profilo: https://it.trustpilot.com/reviews/<ID>
 */
export function estraiTrustpilot(testo: string, oggetto: string): RecensioneTP | null {
  const t = testo.replace(/\r\n/g, "\n");

  const intro = t.match(
    /(.+?)\s+ha (?:scritto|aggiornato) (?:una|la sua) (?:nuova )?recensione a (\d)\s*stell[ae]?\s*di\s*([^\s:]+)\s*:/i,
  );
  const stelleOggetto = oggetto.match(/a\s+(\d)\s+stella/i);

  const idMatch = t.match(/trustpilot\.com\/reviews\/([a-z0-9]+)/i);
  if (!intro && !stelleOggetto) return null;

  const nome = intro?.[1]?.split("\n").pop()?.trim() ?? "";
  const stelleTxt = intro?.[2] ?? stelleOggetto?.[1] ?? "";
  const stelle = stelleTxt ? Number(stelleTxt) : null;

  // Il commento sta fra la riga di introduzione e l'invito a rispondere.
  let commento = "";
  if (intro) {
    const dopo = t.slice((intro.index ?? 0) + intro[0].length);
    commento = dopo.split(/Leggi la recensione|Oppure leggi la recensione|Trustpilot A\/S/i)[0];
  }

  return {
    nome: nome || "(senza nome)",
    stelle: stelle && stelle >= 1 && stelle <= 5 ? stelle : null,
    commento: commento.replace(/\s+/g, " ").trim(),
    idRecensione: idMatch?.[1] ?? "",
    sito: intro?.[3] ?? "",
    aggiornata: /è stata aggiornata|ha aggiornato/i.test(`${oggetto} ${t.slice(0, 300)}`),
  };
}

async function main() {
  const mesi = Number(process.argv[2]) || 5;
  const { activeMailbox, resolveGraph } = await import("@/server/settings");
  const { htmlToText } = await import("@/server/reviews/parse");
  const { riconosciLingua } = await import("@/server/reviews/lingua");

  const cfg = await resolveGraph();
  const mailbox = await activeMailbox();
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

  console.log(`Casella: ${mailbox}`);
  console.log(`Periodo: dal ${da.toISOString().slice(0, 10)} a oggi (${mesi} mesi)\n`);
  console.log("Passo 1 — scansione della posta…");

  let url =
    `${base}/messages?$filter=receivedDateTime ge ${da.toISOString()}` +
    `&$select=id,conversationId,subject,receivedDateTime,from,toRecipients,ccRecipients,bodyPreview` +
    `&$orderby=receivedDateTime desc&$top=999`;
  const tutti: Msg[] = [];
  while (url) {
    const r = await fetch(url, { headers: H, cache: "no-store" });
    if (!r.ok) throw new Error(`Graph ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = (await r.json()) as { value: Msg[]; "@odata.nextLink"?: string };
    tutti.push(...j.value);
    process.stdout.write(`\r  ${tutti.length} email lette   `);
    url = j["@odata.nextLink"] ?? "";
  }
  console.log(`\r  ${tutti.length} email totali nel periodo.\n`);

  // Le notifiche Trustpilot si riconoscono dall'oggetto.
  const NOTIFICA = /Hai una nuova recensione a \d stella|Una recensione a \d stella.*aggiornata/i;
  const candidate = tutti.filter((m) => NOTIFICA.test(m.subject ?? ""));

  // Una per conversazione: la più vecchia è la notifica originale.
  const perConv = new Map<string, Msg[]>();
  for (const m of tutti) {
    const k = m.conversationId || m.id;
    const a = perConv.get(k);
    if (a) a.push(m);
    else perConv.set(k, [m]);
  }

  const originali = new Map<string, Msg>();
  for (const m of candidate) {
    const k = m.conversationId || m.id;
    const p = originali.get(k);
    if (!p || m.receivedDateTime < p.receivedDateTime) originali.set(k, m);
  }

  console.log(
    `Passo 2 — ${candidate.length} notifiche, ${originali.size} conversazioni. Scarico i testi…`,
  );

  const problemi = new Map<string, number>();
  const conCorpo: (Msg | null)[] = [];
  const elenco = [...originali.values()];
  for (let i = 0; i < elenco.length; i += 6) {
    const gruppo = await Promise.all(
      elenco.slice(i, i + 6).map(async (m) => {
        for (let k = 0; k < 6; k++) {
          const r = await fetch(
            `${base}/messages/${encodeURIComponent(m.id)}?$select=subject,body,receivedDateTime`,
            { headers: H, cache: "no-store" },
          );
          if (r.status === 429 || r.status === 503) {
            const attesa = Number(r.headers.get("Retry-After") ?? "") || 2 ** k;
            await new Promise((ok) => setTimeout(ok, attesa * 1000));
            continue;
          }
          if (!r.ok) {
            problemi.set(String(r.status), (problemi.get(String(r.status)) ?? 0) + 1);
            return null;
          }
          const d = (await r.json()) as Msg;
          return { ...m, body: d.body };
        }
        problemi.set("429 ripetuto", (problemi.get("429 ripetuto") ?? 0) + 1);
        return null;
      }),
    );
    conCorpo.push(...gruppo);
    process.stdout.write(`\r  ${Math.min(i + 6, elenco.length)}/${elenco.length}   `);
  }
  console.log(`\r  ${conCorpo.filter(Boolean).length}/${elenco.length} testi scaricati.`);
  if (problemi.size) {
    console.log(`  persi: ${[...problemi].map(([k, v]) => `${v}× ${k}`).join(", ")}`);
  }

  // ------------------------------------------------------------- estrazione
  type Riga = RecensioneTP & {
    data: Date;
    conversationId: string;
    flusso: Msg[];
  };
  const righe: Riga[] = [];
  let nonLetti = 0;

  for (const m of conCorpo) {
    if (!m?.body?.content) continue;
    const testo =
      m.body.contentType?.toLowerCase() === "html"
        ? htmlToText(m.body.content)
        : (m.body.content ?? "");
    const r = estraiTrustpilot(testo, m.subject ?? "");
    if (!r) {
      nonLetti++;
      continue;
    }
    righe.push({
      ...r,
      data: new Date(m.receivedDateTime),
      conversationId: m.conversationId ?? m.id,
      flusso: (perConv.get(m.conversationId ?? m.id) ?? []).sort(
        (a, b) => +new Date(a.receivedDateTime) - +new Date(b.receivedDateTime),
      ),
    });
  }

  const nuove = righe.filter((r) => !r.aggiornata);
  const aggiornate = righe.filter((r) => r.aggiornata);

  const date = righe.map((r) => r.data.getTime());
  const giorni = date.length > 1 ? (Math.max(...date) - Math.min(...date)) / 86400000 : 1;
  const settimane = Math.max(1, giorni / 7);

  console.log("\n" + "=".repeat(74));
  console.log(`TRUSTPILOT — ${righe.length} notifiche interpretate su ${elenco.length}`);
  console.log(`${settimane.toFixed(1)} settimane di dati`);
  if (nonLetti) console.log(`${nonLetti} non interpretabili`);
  console.log("=".repeat(74));

  console.log(`\n  recensioni nuove:     ${nuove.length}`);
  console.log(`  recensioni aggiornate:${String(aggiornate.length).padStart(4)}`);
  console.log(`\n  MEDIA A SETTIMANA:    ${(righe.length / settimane).toFixed(1)} in tutto`);
  console.log(`                        ${(nuove.length / settimane).toFixed(1)} nuove`);

  // Distribuzione stelle
  console.log("\nDISTRIBUZIONE PER PUNTEGGIO (solo recensioni nuove)");
  const perStelle: Record<string, number> = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0, "?": 0 };
  for (const r of nuove) perStelle[r.stelle ? String(r.stelle) : "?"]++;
  for (const s of ["5", "4", "3", "2", "1", "?"]) {
    const n = perStelle[s];
    if (!n && s === "?") continue;
    const pct = nuove.length ? (n / nuove.length) * 100 : 0;
    console.log(
      `  ${s === "?" ? "n/d" : s + "★ "} ${String(n).padStart(4)}  ${pct.toFixed(1).padStart(5)}%  ${"█".repeat(Math.round(pct / 2))}`,
    );
  }

  // Commenti e lingua
  const conTesto = nuove.filter((r) => r.commento.length > 0);
  const senzaTesto = nuove.length - conTesto.length;
  const lunghezze = conTesto.map((r) => r.commento.length).sort((a, b) => a - b);
  const mediana = lunghezze.length ? lunghezze[Math.floor(lunghezze.length / 2)] : 0;
  console.log("\nCOMMENTI");
  console.log(`  con testo:   ${conTesto.length}`);
  console.log(`  senza testo: ${senzaTesto}`);
  console.log(`  lunghezza mediana: ${mediana} caratteri`);
  const italiane = conTesto.filter((r) => riconosciLingua(r.commento) === "it").length;
  console.log(
    `  in italiano: ${italiane} su ${conTesto.length} (${conTesto.length ? ((italiane / conTesto.length) * 100).toFixed(0) : 0}%)`,
  );

  // Id della recensione: serve per rispondere via API
  const conId = righe.filter((r) => r.idRecensione).length;
  console.log(`\nID DELLA RECENSIONE presente nell'email: ${conId} su ${righe.length}`);
  if (conId) console.log(`  esempio: ${righe.find((r) => r.idRecensione)?.idRecensione}`);
  const siti = new Map<string, number>();
  for (const r of righe) if (r.sito) siti.set(r.sito, (siti.get(r.sito) ?? 0) + 1);
  console.log(`  siti recensiti: ${[...siti].map(([s, n]) => `${s} (${n})`).join(", ")}`);

  // ------------------------------------------------------- cosa fa Stefania
  console.log("\n" + "=".repeat(74));
  console.log("COSA SUCCEDE DOPO — i flussi");
  console.log("=".repeat(74));

  let sole = 0;
  const destinatari = new Map<string, number>();
  const testiRisposta = new Map<string, number>();
  const ritardi: number[] = [];

  for (const r of righe) {
    const dopo = r.flusso.filter(
      (m) =>
        new Date(m.receivedDateTime) > r.data &&
        /galdierirent/i.test(m.from?.emailAddress?.address ?? ""),
    );
    if (dopo.length === 0) {
      sole++;
      continue;
    }
    const primo = dopo[0];
    ritardi.push((+new Date(primo.receivedDateTime) - +r.data) / 3600000);
    for (const d of primo.toRecipients ?? []) {
      const a = d.emailAddress?.address ?? "?";
      destinatari.set(a, (destinatari.get(a) ?? 0) + 1);
    }
    const testo = senzaFirma(pulisci(primo.bodyPreview ?? primo.body?.content ?? ""))
      .split("\n")[0]
      .slice(0, 46);
    if (testo) testiRisposta.set(testo, (testiRisposta.get(testo) ?? 0) + 1);
  }

  console.log(`\n  notifiche senza alcun seguito: ${sole} su ${righe.length}`);
  console.log(`  con un seguito:                ${righe.length - sole}`);
  if (ritardi.length) {
    ritardi.sort((a, b) => a - b);
    console.log(
      `  tempo mediano prima del primo passo: ${ritardi[Math.floor(ritardi.length / 2)].toFixed(1)} ore`,
    );
  }

  console.log(`\n  A CHI VA IL PRIMO MESSAGGIO`);
  for (const [k, v] of [...destinatari].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log(`    ${String(v).padStart(3)}× ${k}`);
  }

  console.log(`\n  COME COMINCIA IL PRIMO MESSAGGIO`);
  for (const [k, v] of [...testiRisposta].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`    ${String(v).padStart(3)}× «${k}»`);
  }

  // Andamento settimanale
  console.log("\nANDAMENTO SETTIMANALE (nuove)");
  const perSett = new Map<string, { tot: number; neg: number }>();
  for (const r of nuove) {
    const k = settimana(r.data);
    const v = perSett.get(k) ?? { tot: 0, neg: 0 };
    v.tot++;
    if (r.stelle === 1 || r.stelle === 2) v.neg++;
    perSett.set(k, v);
  }
  console.log(`  settimana   totale   1-2★`);
  for (const k of [...perSett.keys()].sort()) {
    const v = perSett.get(k)!;
    console.log(`  ${k}   ${String(v.tot).padStart(6)}   ${String(v.neg).padStart(4)}`);
  }

  // Qualche caso, per capire
  console.log("\nESEMPI");
  for (const r of nuove.slice(0, 5)) {
    console.log(`\n  ${r.stelle}★  ${r.nome}  (${r.data.toISOString().slice(0, 10)})`);
    console.log(`     «${r.commento.slice(0, 110) || "(nessun commento)"}»`);
    console.log(`     id: ${r.idRecensione || "—"}`);
    for (const m of r.flusso.slice(1, 4)) {
      const f = (m.from?.emailAddress?.address ?? "?").split("@")[0];
      const a = (m.toRecipients ?? []).map((x) => x.emailAddress?.address?.split("@")[0]).join(",");
      const c = senzaFirma(pulisci(m.bodyPreview ?? m.body?.content ?? "")).replace(/\s+/g, " ");
      console.log(`     → ${f} a ${a}: ${c.slice(0, 70)}`);
    }
  }

  console.log(`\nRichieste HTTP di lettura: ${letture}. Scritture: 0 (bloccate per costruzione).`);
}

main().catch((e) => {
  console.error("\nERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
