import { chromium, type Browser, type BrowserContext } from "playwright";
import { GRUPPI, cercaNeiGruppiPerPagina } from "@/server/robot/google";

//   npm run robot:banco-gruppi
//
// Banco della RICERCA NEI GRUPPI, la strada che prende il robot quando la sede
// non conclude. Finte pagine di gruppo servite da una route di Playwright: il
// codice è quello vero, Google non viene mai contattato e non serve login.
//
// Il caso che ha imposto questo banco (2/11/2026, «Davide Di fusco», Lancusi).
// La ricerca nei gruppi dava per buono che le recensioni nuove stiano in cima
// alla pagina 1. Quel giorno la prima pagina del gruppo portava le recensioni
// di LUGLIO — Capasso del 24/7, Senatore e Botticella del 23/7, «anna ciao»
// del 22/7 — e cinque pagine da cinquanta card non bastano ad arrivare a oggi:
// «non trovata» su una recensione che era lì. Stessa cosa per Franco Lauro,
// debora santagata e Remo Lamanna, tutti di Lancusi; e nelle segnalazioni di
// ottobre «non va, rispondo manualmente» compare 30 volte.
//
// Qui si prova che:
//  1. col campo di ricerca la recensione si trova anche se sta OLTRE l'ultima
//     pagina guardata (è il caso vero);
//  2. senza campo di ricerca si scorre come prima — il ripiego non è toccato;
//  3. filtrare NON indebolisce la prudenza: due omonimi senza niente per
//     distinguerli restano intoccati;
//  4. la ricerca non inventa: se quel nome non c'è, non si scrive niente;
//  5. non si scrive mai nella ricerca delle SEDI, che è un altro campo.

type Card = {
  autore: string;
  stelle: number;
  testo: string;
  /** Se c'è, la recensione ha già una risposta: niente «Rispondi». */
  risposta?: string;
};

/** La risposta come arriva dal form: righe separate da «\r\n». */
const RISPOSTA = "Salve,\r\nPROVA — non pubblicare.";

/** Il bersaglio: 5★ SECCA, senza una parola di testo. Come Di Fusco. */
const BERSAGLIO: Card = { autore: "Davide Di fusco", stelle: 5, testo: "" };

/**
 * Una pagina di recensioni vecchie, come quelle che occupavano le prime pagine
 * del gruppo: quasi tutte già risposte, e una ancora aperta che però è di un
 * altro — serve anche a tenere il banco veloce, perché una vista senza nemmeno
 * un «Rispondi» fa aspettare al robot i suoi 12 secondi di cortesia.
 */
function vecchie(n: number): Card[] {
  return [
    {
      autore: `Massimiliano Capasso ${n}`,
      stelle: 5,
      testo: "Tutto perfetto.",
      risposta: "Grazie!",
    },
    { autore: `Agostino Senatore ${n}`, stelle: 5, testo: "Bene.", risposta: "Grazie!" },
    { autore: `anna ciao ${n}`, stelle: 5, testo: "", risposta: "Grazie!" },
    { autore: `Egidio Grillo ${n}`, stelle: 4, testo: "Nella media." },
  ];
}

/**
 * La finta pagina di un gruppo. Tiene TUTTE le card in memoria e ne mostra una
 * pagina per volta, col pulsante «Pagina successiva»: così il bersaglio può
 * stare oltre l'ultima pagina guardata, che è il caso vero.
 *
 * `conRicerca` decide se la pagina ha il campo «cerca nelle recensioni». Quando
 * c'è, scrivere un nome e premere Invio mostra le card di QUALUNQUE pagina il
 * cui autore contenga quel nome — è quello che fa Google.
 */
function paginaGruppo(pagine: Card[][], conRicerca: boolean): string {
  return `
<!doctype html><meta charset="utf-8"><title>finto gruppo Google</title>
<style>body{font-family:sans-serif;margin:20px} article{border:1px solid #ddd;padding:10px;margin:10px 0}
.avatar{display:inline-block;width:32px;height:32px;border-radius:50%;background:#c33;color:#fff;text-align:center;line-height:32px;margin-right:8px}
button{padding:8px 14px}</style>

<h1>Recensioni del gruppo</h1>
${conRicerca ? '<input id="cerca" placeholder="Cerca recensioni" aria-label="Cerca nelle recensioni">' : ""}
<input id="cerca-sedi" placeholder="Cerca sedi" aria-label="Cerca un'attivita">
<button id="next" aria-label="Pagina successiva"><span class="notranslate" aria-hidden="true">navigate_next</span></button>
<div id="lista"></div>

<script>
  window.__cliccato = [];
  window.__pubblicato = false;
  window.__pagina = 1;
  window.__cercatoSedi = "";
  var PAGINE = ${JSON.stringify(pagine)};

  function disegna(cards) {
    var html = "";
    for (var n = 0; n < cards.length; n++) {
      var c = cards[n];
      html += '<article class="VaHEVc" data-autore="' + c.autore + '">'
        + '<div class="N0c6q"><div class="avatar">' + c.autore.charAt(0) + '</div>'
        + '<a href="https://www.google.com/maps/contrib/' + n + '-' + window.__pagina + '/reviews?hl=it" jsname="xs1xe">'
        + c.autore + '<i class="google-symbols notranslate" aria-hidden="true">open_in_new</i></a></div>'
        + '<span role="img" aria-label="' + c.stelle + ' su 5 stelle"></span><span class="KEfuhb"> 5 giorni fa</span>'
        + '<div class="testo">' + c.testo + '</div>'
        + (c.risposta
            ? '<div class="risposta"><b>Risposta del proprietario</b><div>' + c.risposta + '</div></div>'
            : '<div class="azioni"><button class="rispondi">Rispondi</button></div>')
        + '</article>';
    }
    document.getElementById("lista").innerHTML = html;
    var bottoni = document.querySelectorAll("button.rispondi");
    for (var i = 0; i < bottoni.length; i++) {
      bottoni[i].addEventListener("click", function () {
        var art = this.closest("article");
        window.__cliccato.push(art.dataset.autore);
        var box = document.createElement("div");
        box.className = "riquadro";
        box.innerHTML = '<textarea placeholder="La tua risposta"></textarea>'
          + '<div><button class="pubblica" disabled>Pubblica risposta</button><button class="annulla">Annulla</button></div>';
        art.querySelector(".azioni").replaceWith(box);
        var ta = box.querySelector("textarea");
        var pub = box.querySelector(".pubblica");
        ta.addEventListener("input", function () { pub.disabled = ta.value.trim().length === 0; });
        pub.addEventListener("click", function () { window.__pubblicato = true; });
      });
    }
  }

  disegna(PAGINE[0] || []);

  document.getElementById("next").addEventListener("click", function () {
    if (window.__pagina >= PAGINE.length) return;   // fine gruppo: non cambia niente
    window.__pagina = window.__pagina + 1;
    disegna(PAGINE[window.__pagina - 1]);
  });

  var cerca = document.getElementById("cerca");
  if (cerca) {
    cerca.addEventListener("keydown", function (ev) {
      if (ev.key !== "Enter") return;
      var q = cerca.value.trim().toLowerCase();
      var tutte = [];
      for (var i = 0; i < PAGINE.length; i++) tutte = tutte.concat(PAGINE[i]);
      var trovate = [];
      for (var j = 0; j < tutte.length; j++) {
        if (tutte[j].autore.toLowerCase().indexOf(q) >= 0) trovate.push(tutte[j]);
      }
      disegna(trovate);
    });
  }

  // La ricerca delle SEDI non filtra le recensioni: se il robot ci scrivesse
  // dentro, la lista resterebbe quella di prima. Serve a provare che non la usa.
  document.getElementById("cerca-sedi").addEventListener("keydown", function (ev) {
    if (ev.key === "Enter") window.__cercatoSedi = document.getElementById("cerca-sedi").value;
  });
</script>
`;
}

/** Serve la finta pagina su tutti gli URL dei gruppi veri. */
async function contestoFinto(
  browser: Browser,
  pagine: Card[][],
  conRicerca: boolean,
): Promise<BrowserContext> {
  const ctx = await browser.newContext();
  const html = paginaGruppo(pagine, conRicerca);
  for (const g of GRUPPI) {
    await ctx.route(g.url, (route) =>
      route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }),
    );
  }
  return ctx;
}

/** Cosa è successo nelle finte pagine dopo il codice vero. */
async function stato(ctx: BrowserContext) {
  let cliccati: string[] = [];
  let pubblicato = false;
  let scritto = "";
  let scrittoDi = "";
  let cercatoSedi = "";
  for (const page of ctx.pages()) {
    const s = await page
      .evaluate(() => {
        const w = window as unknown as {
          __cliccato?: string[];
          __pubblicato?: boolean;
          __cercatoSedi?: string;
        };
        const t = document.querySelector("textarea") as HTMLTextAreaElement | null;
        const a = t ? t.closest("article") : null;
        return {
          cliccati: w.__cliccato ?? [],
          pubblicato: w.__pubblicato ?? false,
          scritto: t ? t.value : "",
          scrittoDi: a ? ((a as HTMLElement).dataset.autore ?? "") : "",
          cercatoSedi: w.__cercatoSedi ?? "",
        };
      })
      .catch(() => null);
    if (!s) continue;
    cliccati = cliccati.concat(s.cliccati);
    pubblicato = pubblicato || s.pubblicato;
    if (s.scritto) scritto = s.scritto;
    if (s.scrittoDi) scrittoDi = s.scrittoDi;
    if (s.cercatoSedi) cercatoSedi = s.cercatoSedi;
  }
  return { cliccati, pubblicato, scritto, scrittoDi, cercatoSedi };
}

let ko = 0;

/** Esegue una prova e la racconta SUBITO: il banco è lento, e se crolla si sa dove. */
async function prova(
  nome: string,
  browser: Browser,
  pagine: Card[][],
  conRicerca: boolean,
  cerca: string,
  maxPagine: number,
  controlli: (
    esito: Awaited<ReturnType<typeof cercaNeiGruppiPerPagina>>,
    s: Awaited<ReturnType<typeof stato>>,
    passi: string[],
  ) => [string, boolean][],
): Promise<void> {
  console.log(`\n=== ${nome} ===`);
  const ctx = await contestoFinto(browser, pagine, conRicerca);
  const passi: string[] = [];
  try {
    const esito = await cercaNeiGruppiPerPagina(ctx, cerca, RISPOSTA, {
      testoRecensione: "",
      maxPagine,
      log: (m) => passi.push(m),
    });
    const s = await stato(ctx);
    passi.forEach((r, n) => console.log("   " + String(n + 1).padStart(2) + ". " + r));
    console.log("   --- controlli ---");
    for (const [che, ok] of controlli(esito, s, passi)) {
      if (!ok) ko++;
      console.log(`   ${ok ? "ok  " : "KO  "} ${che}`);
    }
  } catch (e) {
    ko++;
    passi.forEach((r, n) => console.log("   " + String(n + 1).padStart(2) + ". " + r));
    console.log(`   KO   la prova è ESPLOSA: ${e instanceof Error ? e.message : e}`);
  } finally {
    await ctx.close().catch(() => {});
  }
}

(async () => {
  const browser = await chromium.launch({ headless: true });

  // A) IL CASO VERO: il bersaglio sta in quarta pagina, ma si guardano solo due
  //    — ed è il campo di ricerca a tirarlo fuori.
  await prova(
    "il bersaglio è OLTRE le pagine guardate, ma c'è il campo di ricerca",
    browser,
    [vecchie(1), vecchie(2), vecchie(3), [BERSAGLIO]],
    true,
    BERSAGLIO.autore,
    2,
    (esito, s) => [
      ["trovata", esito.trovata === true],
      ["e scritta", esito.scritto === true],
      ["l'ha trovata CERCANDOLA per nome, non scorrendo", /cercata per nome/.test(esito.dettaglio)],
      ["ha cliccato UN solo «Rispondi»", s.cliccati.length === 1],
      [
        "ed era quello di Di fusco",
        s.cliccati[0] === BERSAGLIO.autore && s.scrittoDi === BERSAGLIO.autore,
      ],
      [
        "la risposta è nel riquadro, a capo singoli",
        s.scritto === "Salve,\nPROVA — non pubblicare.",
      ],
      ["NON ha pubblicato", s.pubblicato === false],
      ["NON ha scritto nella ricerca delle SEDI", s.cercatoSedi === ""],
    ],
  );

  // B) Senza campo di ricerca: si scorre come prima, e il bersaglio oltre le
  //    pagine guardate resta fuori portata. È il comportamento di sempre.
  await prova(
    "senza campo di ricerca: scorre le pagine come prima",
    browser,
    [vecchie(1), vecchie(2), vecchie(3), [BERSAGLIO]],
    false,
    BERSAGLIO.autore,
    2,
    (esito, s, passi) => [
      ["ha detto che qui si scorre", passi.some((m) => /qui si scorre/.test(m))],
      ["ha scorso fino alla seconda pagina", passi.some((m) => /pagina 2: cerco/.test(m))],
      ["non trovata (sta in quarta)", esito.trovata === false],
      ["NON ha cliccato niente", s.cliccati.length === 0],
      ["NON ha pubblicato", s.pubblicato === false],
    ],
  );

  // C) Il ripiego funziona ancora: senza campo, ma col bersaglio in prima
  //    pagina, lo scorrimento lo trova e scrive.
  await prova(
    "ripiego intatto: senza campo, il bersaglio in prima pagina si trova scorrendo",
    browser,
    [[...vecchie(1), BERSAGLIO]],
    false,
    BERSAGLIO.autore,
    2,
    (esito, s) => [
      ["trovata", esito.trovata === true],
      ["e scritta", esito.scritto === true],
      ["l'ha trovata SCORRENDO", /pagina 1 ·/.test(esito.dettaglio)],
      [
        "ha cliccato solo il suo «Rispondi»",
        s.cliccati.length === 1 && s.cliccati[0] === BERSAGLIO.autore,
      ],
      ["NON ha pubblicato", s.pubblicato === false],
    ],
  );

  // D) PRUDENZA: due omonimi senza una parola di testo per distinguerli. Il
  //    filtro li porta nella stessa vista, e lì non si tocca niente.
  await prova(
    "due omonimi senza testo: il filtro li mette insieme e NON si sceglie",
    browser,
    [vecchie(1), [BERSAGLIO, { ...BERSAGLIO }]],
    true,
    BERSAGLIO.autore,
    2,
    (esito, s, passi) => [
      ["NON ha cliccato nessun «Rispondi»", s.cliccati.length === 0],
      ["NON ha scritto", esito.scritto === false],
      ["NON ha pubblicato", s.pubblicato === false],
      [
        "ha detto perché (omonimi senza niente per distinguerli)",
        passi.some((m) => /senza risposta con l'autore/.test(m)),
      ],
    ],
  );

  // E) Il nome non c'è affatto: la ricerca non deve inventare una card.
  await prova(
    "il nome non esiste: niente card inventate",
    browser,
    [vecchie(1), vecchie(2)],
    true,
    "Nessuno Qui",
    2,
    (esito, s, passi) => [
      ["non trovata", esito.trovata === false],
      ["NON ha cliccato niente", s.cliccati.length === 0],
      ["NON ha pubblicato", s.pubblicato === false],
      ["ha provato prima la ricerca per nome", passi.some((m) => /col campo di ricerca/.test(m))],
      ["e poi ha scorso", passi.some((m) => /pagina 1: cerco/.test(m))],
    ],
  );

  await browser.close();

  console.log(ko === 0 ? "\nTUTTO A POSTO." : `\n${ko} CONTROLLI FALLITI.`);
  process.exit(ko === 0 ? 0 : 1);
})().catch((e) => {
  console.error("ERRORE:", e);
  process.exit(1);
});
