import { readFileSync } from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Prova del riconoscimento della lingua contro la VERITÀ SUL CAMPO.
//
// Non inventa un metro di giudizio: prende le recensioni vere dalla casella e
// le confronta con la lingua che Stefania ha davvero usato per rispondere.
// Se lei ha scritto "Gentile signor ..." la recensione era italiana; se ha
// scritto "Dear Mr ..." non lo era. È l'unico giudice che conta.
//
//   npm run test:lingua
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

const fetchVero = globalThis.fetch;
globalThis.fetch = (async (i: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const metodo = (init?.method ?? "GET").toUpperCase();
  const url = typeof i === "string" ? i : ((i as Request).url ?? String(i));
  if (metodo !== "GET" && !/login\.microsoftonline/.test(url)) {
    throw new Error(`SCRITTURA BLOCCATA: ${metodo} ${url}`);
  }
  return fetchVero(i, init);
}) as typeof fetch;

const pulisci = (h: string) =>
  (h || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();

/** Dalla risposta di Stefania si ricava la lingua che ha scelto lei. */
function linguaDellaRisposta(corpo: string): "it" | "altra" | null {
  const t = corpo.slice(0, 400);
  if (/\b(gentile|buongiorno|salve|grazie mille|la ringraziamo|abbiamo letto)\b/i.test(t)) {
    return "it";
  }
  if (/\b(dear|thank you|good morning|we have carefully|we are sorry)\b/i.test(t)) return "altra";
  if (/^\s*grazie\s*[.!]/i.test(t)) return "it";
  return null;
}

async function main() {
  const { activeMailbox, resolveGraph } = await import("@/server/settings");
  const { htmlToText, parseReview, splitTranslation } = await import("@/server/reviews/parse");
  const { riconosciLingua } = await import("@/server/reviews/lingua");

  const cfg = await resolveGraph();
  const mbx = await activeMailbox();
  const tk = await fetchVero(`https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });
  const token = ((await tk.json()) as { access_token: string }).access_token;
  const H = { Authorization: `Bearer ${token}` };
  const base = `${cfg.graphUrl}/users/${encodeURIComponent(mbx)}`;

  const da = new Date();
  da.setDate(da.getDate() - 45);
  let url =
    `${base}/messages?$filter=receivedDateTime ge ${da.toISOString()}` +
    `&$select=id,conversationId,subject,receivedDateTime,from,toRecipients,body` +
    `&$orderby=receivedDateTime desc&$top=500`;

  type Msg = {
    conversationId?: string;
    id: string;
    receivedDateTime: string;
    from?: { emailAddress?: { address?: string } };
    toRecipients?: { emailAddress?: { address?: string } }[];
    body?: { content?: string; contentType?: string };
  };
  const tutti: Msg[] = [];
  while (url && tutti.length < 4000) {
    const r = await fetch(url, { headers: H, cache: "no-store" });
    if (!r.ok) throw new Error(`Graph ${r.status}`);
    const j = (await r.json()) as { value: Msg[]; "@odata.nextLink"?: string };
    tutti.push(...j.value);
    url = j["@odata.nextLink"] ?? "";
  }

  const perConv = new Map<string, Msg[]>();
  for (const m of tutti) {
    const k = m.conversationId || m.id;
    const a = perConv.get(k);
    if (a) a.push(m);
    else perConv.set(k, [m]);
  }

  const testo = (m: Msg) =>
    m.body?.contentType?.toLowerCase() === "html"
      ? htmlToText(m.body.content ?? "")
      : (m.body?.content ?? "");

  let giusti = 0;
  let sbagliati = 0;
  let incerti = 0;
  const errori: string[] = [];

  for (const [, gruppo] of perConv) {
    const zap = gruppo.find((m) => /zapier/i.test(m.from?.emailAddress?.address ?? ""));
    if (!zap) continue;
    const p = parseReview(testo(zap));
    if (!p) continue;
    const parti = splitTranslation(p.comment);
    const commento = (parti.original || parti.translated).trim();
    if (!commento) continue;

    const risposta = gruppo.find(
      (m) =>
        /stefania/i.test(m.from?.emailAddress?.address ?? "") &&
        m.receivedDateTime > zap.receivedDateTime,
    );
    if (!risposta) continue;

    const attesa = linguaDellaRisposta(pulisci(risposta.body?.content ?? ""));
    if (!attesa) continue;

    const trovata = riconosciLingua(commento);
    if (trovata === "ignota") {
      incerti++;
      continue;
    }
    if (trovata === attesa) {
      giusti++;
    } else {
      sbagliati++;
      if (errori.length < 12) {
        errori.push(
          `  atteso=${attesa.padEnd(5)} trovato=${trovata.padEnd(5)} ${p.name.slice(0, 22).padEnd(22)} «${commento.replace(/\s+/g, " ").slice(0, 62)}»`,
        );
      }
    }
  }

  const totale = giusti + sbagliati;
  console.log(`Confronto con la lingua usata davvero da Stefania:\n`);
  console.log(`  casi con verdetto:  ${totale}`);
  console.log(`  corretti:           ${giusti}`);
  console.log(`  sbagliati:          ${sbagliati}`);
  console.log(`  non riconoscibili:  ${incerti}  (ricadono sull'italiano)`);
  if (totale > 0) {
    const pct = (giusti / totale) * 100;
    console.log(`\n  precisione: ${pct.toFixed(1)}%`);
    if (errori.length) {
      console.log(`\n  casi sbagliati:`);
      for (const e of errori) console.log(e);
    }
    if (pct < 90) {
      console.log(`\nPrecisione sotto il 90%: il riconoscimento non è affidabile.`);
      process.exit(1);
    }
    console.log(`\nESITO: riconoscimento affidabile.`);
  } else {
    console.log(`\nNessun caso confrontabile trovato.`);
  }
}

main().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
