// BANCO DI PROVA del ritentativo sulle SCRITTURE di Microsoft Graph
// (`scritturaConRitentativo`). Non tocca la rete né la casella: le risposte di
// Graph sono fabbricate qui, e la funzione sotto prova è ESATTAMENTE quella che
// gira in produzione.
//
// Perché esiste: il 9/11/2026 la recensione di Michele Minale (5★, Lancusi) è
// finita pubblicata su Google ma senza ticket su Freshdesk. Il nodo «rispondi
// all'email» aveva preso un «Graph 503» passeggero e si era arreso al primo
// colpo, portandosi dietro i quattro nodi seguenti — ed è quell'email, con la
// copia a customer.care, che fa nascere il ticket.
//
// Il controllo che conta davvero è il quinto: 502 e 504 NON si ripetono. Un
// gateway può cadere anche dopo che il messaggio è partito, e ripetere
// vorrebbe dire due email identiche, cioè due ticket gemelli. Se un domani
// qualcuno li aggiunge ai codici ripetibili, questo banco diventa rosso.
//
//   npm run banco:graph

let ko = 0;
function ok(nome: string, cond: boolean, dettaglio = ""): void {
  if (!cond) ko++;
  console.log(`  ${cond ? "ok  " : "KO  "} ${nome}${dettaglio ? ` — ${dettaglio}` : ""}`);
}

/**
 * Una finta Graph: restituisce in fila i codici dati e conta le chiamate.
 * `retryAfter` in secondi, per non far aspettare il banco quanto la produzione.
 */
function finta(codici: number[], retryAfter = 1) {
  const stato = { chiamate: 0 };
  const chiamata = async (): Promise<Response> => {
    const codice = codici[Math.min(stato.chiamate, codici.length - 1)];
    stato.chiamate++;
    return new Response(codice === 200 ? "{}" : null, {
      status: codice,
      headers: codice === 429 || codice === 503 ? { "retry-after": String(retryAfter) } : {},
    });
  };
  return { stato, chiamata };
}

async function main(): Promise<void> {
  const { scritturaConRitentativo } = await import("@/server/graph/client");

  console.log("\n### 1. quando va bene, non si ripete niente");
  {
    const { stato, chiamata } = finta([200]);
    const res = await scritturaConRitentativo(chiamata);
    ok("una sola chiamata", stato.chiamate === 1, `chiamate: ${stato.chiamate}`);
    ok("torna la risposta buona", res.ok && res.status === 200, `stato: ${res.status}`);
  }

  console.log("\n### 2. il 503 passeggero: è il caso Minale, e adesso passa");
  {
    const { stato, chiamata } = finta([503, 200]);
    const res = await scritturaConRitentativo(chiamata);
    ok("ha ritentato una volta", stato.chiamate === 2, `chiamate: ${stato.chiamate}`);
    ok("il secondo colpo è andato", res.ok, `stato finale: ${res.status}`);
  }

  console.log("\n### 3. il 503 ostinato: tre tentativi, poi si arrende e NON solleva");
  {
    const { stato, chiamata } = finta([503]);
    const res = await scritturaConRitentativo(chiamata);
    ok("tre tentativi, non di più", stato.chiamate === 3, `chiamate: ${stato.chiamate}`);
    ok("torna l'ultima risposta, 503", res.status === 503, `stato: ${res.status}`);
  }

  console.log("\n### 4. il 429 aspetta quello che Graph chiede (Retry-After)");
  {
    const { stato, chiamata } = finta([429, 200], 1);
    const prima = Date.now();
    const res = await scritturaConRitentativo(chiamata);
    const passati = Date.now() - prima;
    ok("ha ritentato", stato.chiamate === 2, `chiamate: ${stato.chiamate}`);
    ok("ha aspettato almeno il secondo chiesto", passati >= 900, `attesa: ${passati} ms`);
    ok("e poi è andata", res.ok, `stato: ${res.status}`);
  }

  console.log("\n### 5. un errore di RICHIESTA non si ripete: ripeterlo è solo tempo perso");
  for (const codice of [400, 401, 403, 404]) {
    const { stato, chiamata } = finta([codice]);
    const res = await scritturaConRitentativo(chiamata);
    ok(`${codice}: una chiamata sola`, stato.chiamate === 1, `chiamate: ${stato.chiamate}`);
    ok(`${codice}: torna com'è, la gestisce chi chiama`, res.status === codice);
  }

  console.log("\n### 6. IL PALETTO: 502 e 504 non si ripetono, per non mandare due email");
  for (const codice of [500, 502, 504]) {
    const { stato, chiamata } = finta([codice, 200]);
    const res = await scritturaConRitentativo(chiamata);
    ok(
      `${codice}: NON ripetuto (il messaggio può essere già partito)`,
      stato.chiamate === 1,
      `chiamate: ${stato.chiamate}`,
    );
    ok(`${codice}: l'errore arriva a chi chiama`, res.status === codice);
  }

  console.log(ko === 0 ? "\nTUTTO A POSTO." : `\n${ko} CONTROLLI FALLITI.`);
  process.exit(ko === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
