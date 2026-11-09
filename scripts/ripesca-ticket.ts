import { readFileSync } from "node:fs";
import path from "node:path";

// RIPESCA i ticket delle risposte già pubblicate che ne sono rimaste senza.
//
// Il caso: la risposta esce su Google (la scrive il robot), ma il ticket su
// Freshdesk nasce da un'ALTRA cosa — l'email con la copia a customer.care. Se
// quell'email non parte, o se il ticket nasce più tardi di quanto la coda abbia
// pazienza, la pubblicazione resta «fallito» con i tentativi esauriti e
// `prossimoTentativoIl: null`. Da lì nessuna passata la riprende più: la sweep
// automatica guarda solo le «inattesa». Restano scoperte per sempre — il 9
// novembre 2026 erano undici, la più vecchia di settembre.
//
// Qui NON si inventa una seconda politica di ritentativi: si richiama la stessa
// funzione del tasto «Riprova»/«Chiudi il ticket» della coda (`ritentaChiusura`),
// che azzera il contatore, cerca il ticket con i criteri larghi di oggi — prima
// il numero citato dall'escalation, poi la ricerca per oggetto/data/nome col
// testo della recensione — e se lo trova lo aggancia, lo classifica, gli mette
// il tag sede e la nota, e lo risolve.
//
//   npm run ripesca:ticket                            → guarda e dice, non scrive
//   npm run ripesca:ticket -- --scrivi                → ripesca davvero
//   npm run ripesca:ticket -- --scrivi --solo=minale  → una sola
//   npm run ripesca:ticket -- --scrivi --apri-mail    → vedi sotto
//   npm run ripesca:ticket -- --scrivi --pausa=8000      → più gentile con Freshdesk
//
// Fra una voce e l'altra si aspetta (--pausa, 5 s per difetto): una ricerca
// forzata legge sei pagine di ticket e undici di fila sfondano il limite di cento
// chiamate al minuto. Chi va in 429 NON viene dato per «senza ticket»: finisce
// fra le incerte, da riprovare.
//
// --apri-mail: per quelle che restano senza NESSUN ticket, perché l'email che lo
// apre non è mai partita, rimanda quell'email — riusando il motore delle regole
// con il solo nodo «rispondi all'email» e il testo davvero pubblicato — e poi
// riprogramma la chiusura, così la sweep normale aggancia il ticket appena
// nasce. Manda posta vera: è spento per difetto, si ferma a --max= voci (3) e
// stampa l'elenco prima di muoversi. Rispetta la modalità operativa.

function loadEnv(): void {
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
    // Senza .env non si va da nessuna parte, ma lo dirà il primo accesso.
  }
}
loadEnv();

const giorno = (d: Date | string | null): string =>
  d ? new Date(d).toISOString().replace("T", " ").slice(0, 16) : "—";

function numeroDopo(flag: string, difetto: number): number {
  const a = process.argv.find((x) => x.startsWith(`${flag}=`));
  const n = a ? Number(a.slice(flag.length + 1)) : NaN;
  return Number.isFinite(n) && n > 0 ? n : difetto;
}

type Riga = {
  _id: string;
  nomeCliente: string;
  stelle: number;
  sedeNome: string;
  creataIl: Date;
  ticketId: number | null;
  freshdeskEsito: string;
  freshdeskTentativi: number;
  freshdeskErrore: string;
};

async function main(): Promise<void> {
  const scrivi = process.argv.includes("--scrivi");
  const apriMail = process.argv.includes("--apri-mail");
  const max = numeroDopo("--max", 3);
  // Una ricerca «forzata» legge sei pagine di ticket: undici di fila sfondano il
  // limite di Freshdesk (100 chiamate al minuto), e dal 429 in poi ogni voce
  // fallisce in un decimo di secondo. Provato il 9/11/2026: le ultime quattro
  // non erano «senza ticket», era Freshdesk che aveva smesso di rispondere.
  const pausa = numeroDopo("--pausa", 5000);
  const soloArg = process.argv.find((x) => x.startsWith("--solo="));
  const solo = soloArg ? soloArg.slice("--solo=".length).toLowerCase() : "";

  const { coll, mongo } = await import("@/server/db/connessione");
  const { ritentaChiusura, programmaChiusuraFreshdesk } = await import("@/server/pubblicazione");
  const { leggiPubblicazione } = await import("@/server/db/pubblicazioni");
  const { modoOperativo } = await import("@/server/settings");
  const { ticketUrl } = await import("@/server/integrations/freshdesk");

  const modo = await modoOperativo();
  const avviso = modo === "reale" ? "" : " → le scritture sono simulate";
  console.log(`Modalità operativa: ${modo}${avviso}`);

  const righe = (await (
    await coll("pubblicazioni")
  )
    .find({ stato: "pubblicata", freshdeskEsito: { $ne: "ok" } })
    .sort({ creataIl: 1 })
    .toArray()) as unknown as Riga[];

  const scelte = righe.filter((r) => !solo || (r.nomeCliente ?? "").toLowerCase().includes(solo));
  const filtro = solo ? ` · filtrate da «${solo}»: ${scelte.length}` : "";
  console.log(`\nPubblicazioni senza ticket chiuso: ${righe.length}${filtro}`);
  for (const r of scelte) {
    console.log(
      `  ${giorno(r.creataIl)} · ${(r.nomeCliente ?? "").padEnd(24)} · ${r.stelle}★ · ` +
        `${(r.sedeNome ?? "").padEnd(26)} · esito=${(r.freshdeskEsito ?? "—").padEnd(12)}` +
        `tentativi=${r.freshdeskTentativi ?? 0} · ticket=${r.ticketId ?? "—"}`,
    );
    if (r.freshdeskErrore) console.log(`      «${r.freshdeskErrore}»`);
  }

  if (!scrivi) {
    console.log("\nNiente scritto: questa è solo la fotografia.");
    console.log("Per ripescarle davvero: npm run ripesca:ticket -- --scrivi");
    await (await mongo()).close();
    process.exit(0);
  }

  console.log(`\n--- ripesco (${scelte.length}) ---`);
  const senzaTicket: Riga[] = [];
  let agganciati = 0;
  for (const r of scelte) {
    await ritentaChiusura(r._id, "Ripescaggio");
    const dopo = await leggiPubblicazione(r._id);
    const esito = dopo?.freshdeskEsito ?? "?";
    const tk = dopo?.ticketId ?? null;
    const link = tk ? await ticketUrl(tk).catch(() => "") : "";
    console.log(
      `  ${(r.nomeCliente ?? "").padEnd(24)} → esito=${esito.padEnd(12)}ticket=${tk ?? "—"} ${link}`,
    );
    if (esito === "ok") agganciati++;
    else if (tk == null) senzaTicket.push(r);
    if (r !== scelte[scelte.length - 1]) await new Promise((ok) => setTimeout(ok, pausa));
  }
  console.log(`\nAgganciati e chiusi: ${agganciati} su ${scelte.length}.`);

  if (senzaTicket.length === 0) {
    await (await mongo()).close();
    process.exit(0);
  }

  // «Non trovato» da `ritrovaTicket` è ambiguo: quella funzione inghiotte anche
  // il 429, e un limite di chiamate superato NON vuol dire che il ticket non
  // esista. Siccome il passo dopo (--apri-mail) manda posta vera, e mandarla
  // dove il ticket c'è già vorrebbe dire creare un gemello, qui si ricontrolla
  // una per una distinguendo i due casi.
  console.log("");
  console.log(`Restano ${senzaTicket.length} senza ticket agganciato: ricontrollo una per una…`);
  const { cercaTicketPerRecensione, eLimiteChiamate } =
    await import("@/server/integrations/freshdesk");
  const { leggiRecensione: leggiRec } = await import("@/server/db/recensioni");
  const assenti: Riga[] = [];
  const incerte: Riga[] = [];
  for (const r of senzaTicket) {
    const nome = (r.nomeCliente ?? "").padEnd(24);
    const rec = await leggiRec(r._id);
    if (!rec) {
      console.log(`  ${nome} recensione non più in archivio, salto.`);
      continue;
    }
    try {
      const { ticket } = await cercaTicketPerRecensione(rec.oggetto, rec.ricevutaIl, rec.nome, {
        forza: true,
        testoRecensione: rec.originale,
      });
      if (ticket) {
        console.log(`  ${nome} il ticket c'è: #${ticket.id} — lo riprenderà la coda.`);
      } else {
        assenti.push(r);
        console.log(`  ${nome} su Freshdesk non c'è nessun ticket.`);
      }
    } catch (e) {
      incerte.push(r);
      const perche = eLimiteChiamate(e) ? "limite di chiamate" : "Freshdesk non raggiungibile";
      console.log(`  ${nome} NON LO SO (${perche}): da riprovare più tardi.`);
    }
    if (r !== senzaTicket[senzaTicket.length - 1]) await new Promise((ok) => setTimeout(ok, pausa));
  }

  console.log("");
  console.log(
    `Senza ticket per certo: ${assenti.length} · da ricontrollare: ${incerte.length}.` +
      " Per le prime l'email che apre il ticket non è mai partita.",
  );
  for (const r of assenti) console.log(`  · ${giorno(r.creataIl)} ${r.nomeCliente}`);

  if (!apriMail || assenti.length === 0) {
    if (assenti.length > 0) {
      console.log("");
      console.log(`Per rimandare quell'email (posta vera, al massimo ${max} per volta):`);
      console.log(`  npm run ripesca:ticket -- --scrivi --apri-mail --max=${max}`);
    }
    await (await mongo()).close();
    process.exit(0);
  }

  const { caricaRegole, regolaPer } = await import("@/server/automation/rules");
  const { eseguiRegola } = await import("@/server/automation/engine");
  const { registraEsecuzione, scostamentiDa } = await import("@/server/automation/runs");
  const { leggiRecensione } = await import("@/server/db/recensioni");
  const { haTesto } = await import("@/server/reviews/load");

  const regole = await caricaRegole();
  console.log(`\n--- rimando l'email che apre il ticket (max ${max}) ---`);
  for (const r of assenti.slice(0, max)) {
    const voce = await leggiPubblicazione(r._id);
    const rec = await leggiRecensione(r._id);
    if (!voce || !rec) {
      console.log(`  ${r.nomeCliente}: recensione o pubblicazione non più in archivio, salto.`);
      continue;
    }
    const regola = regolaPer(regole, rec.stelle, haTesto(rec));
    const nodo = regola?.azioni.find((a) => a.tipo === "email.rispondi");
    if (!regola || !nodo) {
      console.log(`  ${r.nomeCliente}: nessuna regola con «rispondi all'email», salto.`);
      continue;
    }
    // Il motore vero, con la regola ridotta al solo nodo dell'email: parte
    // ESATTAMENTE la mail che sarebbe partita allora, col testo pubblicato.
    const riscritto = { azioni: [nodo.id], testo: voce.testoRisposta, originale: "" };
    const esecuzione = await eseguiRegola({ ...regola, azioni: [nodo] }, rec, riscritto);
    await registraEsecuzione(esecuzione, scostamentiDa(riscritto));
    const primo = esecuzione.nodi[0];
    console.log(
      `  ${(r.nomeCliente ?? "").padEnd(24)} → ${primo?.stato ?? "?"}: ${primo?.messaggio ?? ""}`,
    );
    if (esecuzione.esito === "ok") {
      // Il ticket nasce con qualche minuto di ritardo: si riprogramma la
      // chiusura e la sweep normale lo aggancia quando esiste.
      await programmaChiusuraFreshdesk(r._id);
      console.log("      chiusura riprogrammata: la sweep aggancerà il ticket appena nasce.");
    }
  }

  await (await mongo()).close();
  process.exit(0);
}

main().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
