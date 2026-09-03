import { readFileSync } from "node:fs";
import path from "node:path";

// ANALISI della casella + archivio per MAPPARE i comportamenti sulle recensioni.
// SOLA LETTURA. Non categorizza a mano: raccoglie e raggruppa i dati veri.
//   npm run analizza:casella
//   npm run analizza:casella -- 400   (quante mail «inviate» scorrere, default 250)

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

type Rec = { emailAddress?: { address?: string } };

function ruolo(addr: string): string {
  const a = addr.toLowerCase();
  if (a.includes("customer.care")) return "customer.care";
  if (a.includes("cherubina")) return "Cherubina";
  if (a.includes("zapier")) return "Zapier";
  if (a.includes("@galdierirent")) return "interno";
  return a ? "esterno/cliente" : "—";
}

function prefissoAzione(subject: string): string {
  const s = subject.trim().toLowerCase();
  if (/^(r|re)\s*:/.test(s)) return "RISPOSTA (R:)";
  if (/^(i|fw|fwd)\s*:/.test(s)) return "INOLTRO (I:/Fw:)";
  return "NUOVO/altro";
}

async function main() {
  const maxSent = Number(process.argv[2]) || 250;
  const { coll } = await import("@/server/db/connessione");
  const { resolveGraph, activeMailbox } = await import("@/server/settings");

  // ---- 1) Distribuzione recensioni per stelle / testo (dall'archivio) --------
  const rec = await coll("recensioni");
  const perStelle = await rec
    .aggregate([
      { $group: { _id: { stelle: "$stelle", conTesto: { $ifNull: ["$haTesto", false] } }, n: { $sum: 1 } } },
      { $sort: { "_id.stelle": 1, "_id.conTesto": 1 } },
    ])
    .toArray();
  const totRec = await rec.countDocuments({});
  console.log(`================ RECENSIONI IN ARCHIVIO (${totRec}) ================`);
  console.log("stelle · con testo · quante");
  for (const r of perStelle) {
    const s = r._id.stelle ?? "—";
    console.log(`  ${String(s).padStart(2)}★ · ${r._id.conTesto ? "con testo" : "senza   "} · ${r.n}`);
  }

  // ---- 2) Comportamenti di Stefania (Posta inviata) --------------------------
  const cfg = await resolveGraph();
  const mbx = await activeMailbox();
  const tk = await fetch(`https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });
  const token = ((await tk.json()) as { access_token?: string }).access_token;
  if (!token) throw new Error("token non ottenuto");

  const dominio = cfg.graphUrl;
  let url: string | null =
    `${dominio}/users/${encodeURIComponent(mbx)}/mailFolders/SentItems/messages` +
    `?$top=100&$orderby=sentDateTime desc&$select=subject,sentDateTime,toRecipients,ccRecipients,bodyPreview`;

  type Voce = { subject: string; to: Rec[]; cc: Rec[]; preview: string };
  const inviate: Voce[] = [];
  for (let p = 0; url && inviate.length < maxSent; p++) {
    const r: Response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    const j = (await r.json()) as {
      value?: { subject?: string; toRecipients?: Rec[]; ccRecipients?: Rec[]; bodyPreview?: string }[];
      "@odata.nextLink"?: string;
    };
    for (const m of j.value ?? [])
      inviate.push({ subject: m.subject ?? "", to: m.toRecipients ?? [], cc: m.ccRecipients ?? [], preview: (m.bodyPreview ?? "").replace(/\s+/g, " ").trim() });
    url = j["@odata.nextLink"] ?? null;
  }

  const recensione = inviate.filter((v) => /recension/i.test(v.subject));
  console.log(`\n============ POSTA INVIATA: ${inviate.length} scorse, ${recensione.length} sulle recensioni ============`);

  // Testo effettivo (prima della citazione «From:/________»).
  const corpoUtile = (p: string) =>
    p.split(/\s*(?:_{5,}|from:|da:\s|il\s+\w+,?\s+\d)/i)[0].trim();
  const comportamento = (p: string): string => {
    const s = corpoUtile(p).toLowerCase();
    if (/^grazie\.?$/.test(s)) return "A· «Grazie.» — ringraziamento standard (IT)";
    if (/^thank you\.?$/.test(s)) return "A· «Thank you.» — ringraziamento standard (EN)";
    if (/^si trasmette per quanto/.test(s)) return "C· «Si trasmette…» — INOLTRO a Cherubina (negativa)";
    if (/^(gentile|dear)\b/.test(s)) {
      if (/spiacent|sorry|rammarico|disserviz/.test(s)) return "D· «Gentile/Dear…» + spiacenti — risposta a NEGATIVA";
      return "B· «Gentile/Dear <nome>…» — ringraziamento PERSONALIZZATO (positiva con testo)";
    }
    if (/spiacent|sorry/.test(s)) return "D· risposta a NEGATIVA (spiacenti/sorry)";
    return "Z· altro";
  };

  // 2a) Per COMPORTAMENTO (il testo che Stefania scrive).
  const perComp = new Map<string, { n: number; dest: Map<string, number> }>();
  for (const v of recensione) {
    const c = comportamento(v.preview);
    const dest = ruolo(v.to[0]?.emailAddress?.address ?? "");
    const g = perComp.get(c) ?? { n: 0, dest: new Map() };
    g.n++;
    g.dest.set(dest, (g.dest.get(dest) ?? 0) + 1);
    perComp.set(c, g);
  }
  console.log("\n--- COMPORTAMENTI (dal testo scritto) ---");
  for (const [c, g] of [...perComp.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const dest = [...g.dest.entries()].map(([d, n]) => `${d}:${n}`).join(", ");
    console.log(`  ${g.n.toString().padStart(3)}×  ${c}   [${dest}]`);
  }

  // 2b) Per AZIONE → destinatario (contesto).
  const perAz = new Map<string, number>();
  for (const v of recensione) {
    const az = prefissoAzione(v.subject);
    const dest = ruolo(v.to[0]?.emailAddress?.address ?? "");
    const ccCC = (v.cc ?? []).some((c) => (c.emailAddress?.address ?? "").toLowerCase().includes("customer.care"));
    const key = `${az} → a:${dest}${ccCC ? " +CC cc" : ""}`;
    perAz.set(key, (perAz.get(key) ?? 0) + 1);
  }
  console.log("\n--- AZIONI (prefisso → destinatario) ---");
  for (const [k, n] of [...perAz.entries()].sort((a, b) => b[1] - a[1]))
    console.log(`  ${n.toString().padStart(3)}×  ${k}`);

  process.exit(0);
}

main().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
