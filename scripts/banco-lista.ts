import { chromium, type Browser, type Page } from "playwright";
import {
  cercaClienteNelleRecensioni,
  cercaInPaginaCorrente,
  rispondiAllaRecensione,
  trovaRecensioneNellaLista,
} from "@/server/robot/google";

//   npm run robot:banco-lista
//
// Banco del RIPIEGO sulla LISTA — la strada che si prende quando la coda non
// conclude: per sede (ricerca nelle recensioni, scroll, «Rispondi» della card)
// e per gruppi (pagina corrente). Una finta lista con più recensioni insieme,
// costruita sulle trappole vere di Google, e il codice VERO in Chromium
// headless: nessun login, nessun contatto con Google.
//
// Le trappole, e perché stanno qui:
//  1. i nomi possono essere una lettera («D»): cercarli come SOTTOSTRINGA
//     combacia con mezza pagina, e il «Rispondi» più vicino a quella prima
//     occorrenza è di un altro — in modalità reale ci si pubblicava sopra;
//  2. le foto profilo mancanti sono un cerchio con l'INIZIALE come testo: il
//     «D» di «Daniele» è un elemento col testo esattamente «D»;
//  3. «Vito D'Amico» contiene «D» come parola intera (l'apostrofo separa);
//  4. lo stesso autore può avere una recensione GIÀ con risposta e una senza;
//  5. «Mario Rossini» non è «Mario Rossi»;
//  6. il nome del recensore sta in un <a> con dentro l'icona «open_in_new».

type Card = {
  autore: string;
  stelle: number;
  testo: string;
  /** Se c'è, la recensione ha già una risposta: niente «Rispondi». */
  risposta?: string;
  /** L'iniziale mostrata al posto della foto (di default la prima lettera). */
  iniziale?: string;
};

const TESTO_DB =
  "ATTENTION AVOID LONG WAIT - 3 people in front of us and we have so far waited 1 hr 30 minutes.";
const BERSAGLIO: Card = {
  autore: "D",
  stelle: 1,
  testo:
    "(Traduzione di Google) ATTENZIONE, EVITATE LUNGHE ATTESE - 3 persone davanti a noi e abbiamo aspettato 1 ora e 30 minuti. (Originale) ATTENTION AVOID LONG WAIT - 3 people in front of us and we have so far waited 1 hr 30 minutes.",
};
const DANIELE: Card = { autore: "Daniele Rossi", stelle: 5, testo: "Servizio ottimo, personale disponibile. Consigliato.", iniziale: "D" };
const VITO: Card = { autore: "Vito D'Amico", stelle: 4, testo: "Tutto bene, niente da dire." };
const ALTRA_D: Card = { autore: "D", stelle: 5, testo: "Molto bene, veloci alla consegna e auto pulita." };
const ALTRA_D_RISPOSTA: Card = { ...ALTRA_D, risposta: "Grazie mille!" };

/** La risposta come arriva dal form: righe separate da «\r\n». */
const RISPOSTA = "Salve,\r\nPROVA — non pubblicare.";

function pagina(cards: Card[]): string {
  const articoli = cards
    .map(
      (c, n) => `
  <article class="VaHEVc" data-autore="${c.autore}">
    <div class="N0c6q">
      <div class="avatar">${c.iniziale ?? c.autore[0]}</div>
      <a href="https://www.google.com/maps/contrib/10${n}00${n}/reviews?hl=it" jsname="xs1xe">${c.autore}<i class="google-symbols notranslate" aria-hidden="true">open_in_new</i></a>
    </div>
    <div class="PROnRd">3 recensioni • 0 foto</div>
    <span role="img" aria-label="${c.stelle} su 5 stelle"></span><span class="KEfuhb"> 5 giorni fa</span>
    <div class="testo">${c.testo}</div>
    ${
      c.risposta
        ? `<div class="risposta"><b>Risposta del proprietario</b><div>${c.risposta}</div></div>`
        : `<div class="azioni"><button class="rispondi">Rispondi</button></div>`
    }
  </article>`,
    )
    .join("");

  return `
<!doctype html><meta charset="utf-8"><title>finta lista Google</title>
<style>body{font-family:sans-serif;margin:20px} article{border:1px solid #ddd;padding:10px;margin:10px 0}
.avatar{display:inline-block;width:32px;height:32px;border-radius:50%;background:#c33;color:#fff;text-align:center;line-height:32px;margin-right:8px}
button{padding:8px 14px}</style>

<h1>Recensioni della sede · Galdieri Rent Olbia</h1>
<p>Visualizzazione 1-10 di 348 recensioni</p>
<input id="cerca" placeholder="Cerca recensioni" aria-label="Cerca nelle recensioni">
<button id="cta"><span class="notranslate" aria-hidden="true">reply</span><span>Rispondere a recensioni</span></button>
${articoli}

<script>
  window.__cliccato = [];
  window.__pubblicato = false;
  document.querySelectorAll("button.rispondi").forEach((b) => {
    b.addEventListener("click", () => {
      const art = b.closest("article");
      window.__cliccato.push(art.dataset.autore);
      const box = document.createElement("div");
      box.className = "riquadro";
      box.innerHTML = '<textarea placeholder="La tua risposta"></textarea>' +
        '<div><button class="pubblica" disabled>Pubblica risposta</button><button class="annulla">Annulla</button></div>';
      art.querySelector(".azioni").replaceWith(box);
      const ta = box.querySelector("textarea");
      const pub = box.querySelector(".pubblica");
      ta.addEventListener("input", () => { pub.disabled = ta.value.trim().length === 0; });
      pub.addEventListener("click", () => { window.__pubblicato = true; });
    });
  });
</script>
`;
}

type Prova = { nome: string; controlli: [string, boolean][]; passi: string[] };

/** Cosa è successo nella finta pagina dopo il codice vero. */
async function stato(page: Page) {
  const cliccati = await page.evaluate(() => (window as unknown as { __cliccato: string[] }).__cliccato);
  const pubblicato = await page.evaluate(() => (window as unknown as { __pubblicato: boolean }).__pubblicato);
  const scritto = await page.evaluate(() => {
    const t = document.querySelector("textarea") as HTMLTextAreaElement | null;
    return t ? t.value : "";
  });
  const scrittoDi = await page.evaluate(() => {
    const t = document.querySelector("textarea");
    const a = t ? t.closest("article") : null;
    return a ? (a as HTMLElement).dataset.autore ?? "" : "";
  });
  return { cliccati, pubblicato, scritto, scrittoDi };
}

async function conPagina<T>(browser: Browser, cards: Card[], fai: (page: Page, passi: string[]) => Promise<T>) {
  const page = await browser.newPage();
  await page.setContent(pagina(cards));
  const passi: string[] = [];
  const esito = await fai(page, passi);
  const s = await stato(page);
  await page.close();
  return { esito, passi, ...s };
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const log = (passi: string[]) => (m: string) => passi.push(m);
  const prove: Prova[] = [];

  // A) Il caso vero: «D» col testo dal database, in mezzo a Daniele (iniziale
  //    «D»), Vito D'Amico e un'altra «D» già con risposta.
  {
    const p = await conPagina(browser, [DANIELE, VITO, ALTRA_D_RISPOSTA, BERSAGLIO], (page, passi) =>
      rispondiAllaRecensione(page, "D", RISPOSTA, { log: log(passi), testoRecensione: TESTO_DB }),
    );
    prove.push({
      nome: "per sede: «D» col testo, fra Daniele, Vito D'Amico e un'altra «D» già risposta",
      passi: p.passi,
      controlli: [
        ["ha scritto", p.esito.scritto === true],
        ["ha cliccato UN solo «Rispondi»", p.cliccati.length === 1],
        ["ed era quello della «D» giusta", p.cliccati[0] === "D" && p.scrittoDi === "D"],
        ["NON quello di Daniele (iniziale «D»)", !p.cliccati.includes("Daniele Rossi")],
        ["NON quello di Vito D'Amico", !p.cliccati.includes("Vito D'Amico")],
        ["la risposta è nel riquadro, a capo singoli", p.scritto === "Salve,\nPROVA — non pubblicare."],
        ["l'ha riconosciuta dal TESTO", p.passi.some((m) => m.includes("combacia il testo"))],
        ["NON ha pubblicato", p.pubblicato === false],
      ],
    });
  }

  // B) «D» SENZA testo (5★ secca) e due «D» senza risposta: ambigua, non tocca.
  {
    const p = await conPagina(browser, [DANIELE, VITO, ALTRA_D, BERSAGLIO], (page, passi) =>
      rispondiAllaRecensione(page, "D", RISPOSTA, { log: log(passi) }),
    );
    prove.push({
      nome: "per sede: «D» senza testo e due «D» senza risposta → non sceglie",
      passi: p.passi,
      controlli: [
        ["NON ha cliccato nessun «Rispondi»", p.cliccati.length === 0],
        ["NON ha scritto", p.esito.scritto === false],
        ["ha detto perché (due omonimi)", /2 recensioni senza risposta con l'autore/.test(p.esito.dettaglio)],
      ],
    });
  }

  // C) «D» senza testo, ma l'altra «D» ha già una risposta: resta una sola.
  {
    const p = await conPagina(browser, [DANIELE, VITO, ALTRA_D_RISPOSTA, BERSAGLIO], (page, passi) =>
      rispondiAllaRecensione(page, "D", RISPOSTA, { log: log(passi) }),
    );
    prove.push({
      nome: "per sede: «D» senza testo, una sola «D» senza risposta → la sceglie",
      passi: p.passi,
      controlli: [
        ["ha cliccato UN solo «Rispondi»", p.cliccati.length === 1],
        ["ed era quello della «D» senza risposta", p.scrittoDi === "D" && p.scritto.includes("PROVA")],
        ["NON quello di Daniele", !p.cliccati.includes("Daniele Rossi")],
      ],
    });
  }

  // D) «Mario Rossi» senza testo, con «Mario Rossini» davanti.
  {
    const ROSSINI: Card = { autore: "Mario Rossini", stelle: 5, testo: "Perfetto." };
    const ROSSI: Card = { autore: "Mario Rossi", stelle: 4, testo: "" };
    const p = await conPagina(browser, [ROSSINI, DANIELE, ROSSI], (page, passi) =>
      rispondiAllaRecensione(page, "Mario Rossi", RISPOSTA, { log: log(passi) }),
    );
    prove.push({
      nome: "per sede: «Mario Rossi» senza testo, con «Mario Rossini» davanti",
      passi: p.passi,
      controlli: [
        ["ha cliccato UN solo «Rispondi»", p.cliccati.length === 1],
        ["ed era quello di Mario Rossi", p.cliccati[0] === "Mario Rossi"],
        ["NON quello di Mario Rossini", !p.cliccati.includes("Mario Rossini")],
      ],
    });
  }

  // E) «D» col testo, ma la recensione a schermo ha un testo DIVERSO (cambiata
  //    dal cliente, o è un'altra «D»): non ci si fida del solo nome.
  {
    const p = await conPagina(browser, [DANIELE, VITO, ALTRA_D], (page, passi) =>
      rispondiAllaRecensione(page, "D", RISPOSTA, { log: log(passi), testoRecensione: TESTO_DB }),
    );
    prove.push({
      nome: "per sede: «D» col testo, ma in lista c'è solo una «D» con un testo diverso → non tocca",
      passi: p.passi,
      controlli: [
        ["NON ha cliccato nessun «Rispondi»", p.cliccati.length === 0],
        ["ha detto che non si fida del solo nome", /non mi fido del solo nome/.test(p.esito.dettaglio)],
      ],
    });
  }

  // F) Gruppi: la pagina corrente, stesso caso di A.
  {
    const p = await conPagina(browser, [DANIELE, VITO, ALTRA_D_RISPOSTA, BERSAGLIO], (page, passi) =>
      cercaInPaginaCorrente(page, "D", RISPOSTA, { log: log(passi), testoRecensione: TESTO_DB }),
    );
    prove.push({
      nome: "gruppi: «D» col testo nella pagina corrente",
      passi: p.passi,
      controlli: [
        ["trovata", p.esito.trovata === true],
        ["ha scritto", p.esito.scritto === true],
        ["ha cliccato UN solo «Rispondi», quello giusto", p.cliccati.length === 1 && p.cliccati[0] === "D" && p.scrittoDi === "D"],
        ["NON quello di Daniele", !p.cliccati.includes("Daniele Rossi")],
        ["NON ha pubblicato", p.pubblicato === false],
      ],
    });
  }

  // G) Gruppi: «D» senza testo e con due «D» → non in questa pagina, niente click.
  {
    const p = await conPagina(browser, [DANIELE, VITO, ALTRA_D, BERSAGLIO], (page, passi) =>
      cercaInPaginaCorrente(page, "D", RISPOSTA, { log: log(passi) }),
    );
    prove.push({
      nome: "gruppi: «D» senza testo e due «D» → non sceglie",
      passi: p.passi,
      controlli: [
        ["non trovata (ambigua)", p.esito.trovata === false],
        ["NON ha cliccato", p.cliccati.length === 0],
      ],
    });
  }

  // H) Sola lettura: scroll e ricerca nelle recensioni trovano la card giusta
  //    senza toccare niente.
  {
    const p1 = await conPagina(browser, [DANIELE, VITO, ALTRA_D_RISPOSTA, BERSAGLIO], (page, passi) =>
      trovaRecensioneNellaLista(page, "D", { log: log(passi), testoRecensione: TESTO_DB, maxPassi: 2 }),
    );
    const p2 = await conPagina(browser, [DANIELE, VITO, ALTRA_D_RISPOSTA, BERSAGLIO], (page, passi) =>
      cercaClienteNelleRecensioni(page, "D", { log: log(passi), testoRecensione: TESTO_DB }),
    );
    const p3 = await conPagina(browser, [DANIELE, VITO], (page, passi) =>
      trovaRecensioneNellaLista(page, "D", { log: log(passi), testoRecensione: TESTO_DB, maxPassi: 2 }),
    );
    prove.push({
      nome: "sola lettura: scroll e ricerca nelle recensioni",
      passi: [...p1.passi, "— ricerca —", ...p2.passi, "— senza la sua —", ...p3.passi],
      controlli: [
        ["scroll: trovata", p1.esito.trovata === true],
        ["scroll: non ha toccato niente", p1.cliccati.length === 0],
        ["ricerca: trovata", p2.esito.trovata === true],
        ["ricerca: non ha toccato niente", p2.cliccati.length === 0],
        ["scroll senza la sua: NON trovata (prima «D» combaciava con tutto)", p3.esito.trovata === false],
      ],
    });
  }

  await browser.close();

  let ko = 0;
  for (const p of prove) {
    console.log(`\n=== ${p.nome} ===`);
    p.passi.forEach((r, n) => console.log("   " + String(n + 1).padStart(2) + ". " + r));
    console.log("   --- controlli ---");
    for (const [che, ok] of p.controlli) {
      if (!ok) ko++;
      console.log(`   ${ok ? "ok  " : "KO  "} ${che}`);
    }
  }
  console.log(ko === 0 ? "\nTUTTO A POSTO." : `\n${ko} CONTROLLI FALLITI.`);
  process.exit(ko === 0 ? 0 : 1);
})().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.stack : e);
  process.exit(2);
});
