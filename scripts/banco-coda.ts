import { chromium, type Browser } from "playwright";
import { cercaNellaCoda } from "@/server/robot/google";

type Uscita = "sicura" | "ferma";
type Stile = "semplice" | "popup";

//   npm run robot:banco
//
// Banco di prova della coda: una finta pagina che imita la vista di Google
// (lista della sede col tasto «Rispondere a recensioni», poi il pop-up che
// mostra UNA recensione alla volta con «Ignora»). Fa girare il codice VERO in
// Chromium headless: nessun login, nessun contatto con Google.
//
// Lo stile «popup» è ricostruito dall'HTML REALE della finestra di Google, con
// tutte le sue trappole — ed è lì che sono usciti i difetti veri:
//
//  1. «__name is not defined»: dentro page.evaluate le funzioni con NOME si
//     rompono sotto tsx, e l'errore era pure inghiottito da un catch;
//  2. contare gli elementi senza guardare se sono VISIBILI faceva risultare la
//     coda «già aperta» mentre si era ancora sulla lista;
//  3. riconoscere col solo nome è pericoloso: col cliente «D» si combaciava con
//     «Vito D'Amico» e si sarebbe scritto sotto la SUA recensione;
//  4. il campo di risposta non ha un placeholder ma un'etichetta flottante, e
//     senza riconoscerlo il metodo si fermava prima di premere «Ignora»;
//  5. il nome del recensore sta in un <a> che contiene ANCHE l'icona
//     «open_in_new» — una legatura testuale — quindi il testo dell'elemento
//     è «Dopen_in_new» e il confronto col nome non combaciava MAI;
//  6. la recensione lunga è mostrata tagliata: il testo intero c'è, ma in un
//     nodo display:none che innerText non restituisce.

type Recensione = { autore: string; stelle: number; testo: string; testoPieno?: string };

const RECENSIONI: Recensione[] = [
  { autore: "rhita prince", stelle: 5, testo: "Accueil simple mais pas d'embrouille à la restitution." },
  // La trappola dei nomi: col vecchio confronto «contiene», cercando «D» ci si
  // fermava qui e si scriveva sotto la recensione di un estraneo.
  { autore: "Vito D'Amico", stelle: 4, testo: "Tutto bene, niente da dire." },
  { autore: "Caro", stelle: 1, testo: "2 Stunden Wartezeit bis man sein Auto bekommt!!!" },
  {
    autore: "D",
    stelle: 1,
    // Come lo mostra Google: tagliato, con la parte intera nascosta sotto.
    testo: "(Traduzione di Google) ATTENZIONE, EVITATE LUNGHE ATTESE - 3 persone davanti a noi…",
    testoPieno:
      "(Traduzione di Google) ATTENZIONE, EVITATE LUNGHE ATTESE - 3 persone davanti a noi e abbiamo aspettato 1 ora e 30 minuti. (Originale) ATTENTION AVOID LONG WAIT - 3 people in front of us and we have so far waited 1 hr 30 minutes.",
  },
];
const BERSAGLIO = RECENSIONI[3];
/** Quello che sta nel database: l'originale scritto dal cliente. */
const TESTO_DB = "ATTENTION AVOID LONG WAIT - 3 people in front of us and we have so far waited 1 hr 30 minutes.";

/** I due tasti del pop-up, col testo dentro uno span annidato come su Google. */
const TASTI = `
  <button id="ignora" class="AeBiU-LgbsSe FwaX8 nq9VD P8Hxme" jsname="dmDvRc">
    <span class="XjoK4b"></span><span class="UTNHae"></span>
    <span jsname="V67aGc" class="AeBiU-vQzf8d">Ignora</span><span jsname="UkTUqb"></span>
  </button>
  <button id="invia" class="UywwFc-LgbsSe FwaX8 P8Hxme" jsname="hrGhad" disabled>
    <span class="XjoK4b"></span><span class="MMvswb"><span class="OLCwg"></span></span>
    <span jsname="V67aGc" class="UywwFc-vQzf8d">Rispondi</span><span jsname="UkTUqb"></span>
  </button>`;

function pagina(stile: Stile): string {
  const popup = stile === "popup";

  // La LISTA sotto: contiene altre recensioni, comprese quelle che compaiono
  // anche nella coda. Se il codice non si limita al dialogo, le mescola.
  const lista = RECENSIONI.slice(0, 2)
    .map(
      (r) => `<article class="VaHEVc"><div class="N0c6q"><a href="https://www.google.com/maps/contrib/999/reviews">${r.autore}<i class="google-symbols" aria-hidden="true">open_in_new</i></a></div>
        <span role="img" aria-label="${r.stelle} su 5 stelle"></span><div>${r.testo}</div>
        <button>Rispondi</button></article>`,
    )
    .join("");

  const campo = popup
    ? `<textarea id="campo" rows="2" jsname="YPqjbf" aria-label="La tua risposta pubblica" maxlength="4000"></textarea>`
    : `<textarea id="campo" placeholder="Risposta pubblica"></textarea>`;

  return `
<!doctype html><meta charset="utf-8"><title>finta Google</title>
<style>body{font-family:sans-serif;margin:20px} .riga{display:flex;gap:8px;margin-top:10px}
button{padding:8px 14px} .nascosto{display:none}</style>

<div id="lista">
  <h1>Recensioni della sede</h1>
  <p>Visualizzazione 1-10 di 348 recensioni</p>
  ${lista}
  <button id="banner-chiudi">Ignora</button>
  <!-- il tasto della coda: etichetta spezzata in due span, come su Google -->
  <button id="cta" jsname="WSkPNc"><span class="notranslate" aria-hidden="true">reply</span><span jsname="V67aGc">Rispondere a recensioni</span></button>
</div>

<div id="coda" class="nascosto" ${popup ? 'role="dialog" aria-labelledby="i1"' : ""}>
  ${popup ? '<h1 id="i1"><span>Rispondi alla recensione</span></h1>' : ""}
  <div class="LTHHeb" id="contatore"></div>
  <article class="VaHEVc" aria-label="Rivedi">
    <div class="N0c6q">
      <!-- IL NOME sta qui dentro, insieme all'icona: il testo grezzo di questo
           elemento è «Dopen_in_new», non «D». -->
      <a id="autore" href="https://www.google.com/maps/contrib/108862094096472059186/reviews?hl=it"
         jsname="xs1xe" aria-label="Link al profilo del recensore"></a>
    </div>
    <div class="PROnRd">3 recensioni • 0 foto</div>
    <span id="stelle" role="img" aria-label=""></span>
    <span class="KEfuhb"> 5 giorni fa</span>
    <div>
      <div id="testo-corto" jsname="lvvS4b"></div>
      <div id="testo-pieno" jsname="PBWx0c" style="display: none;"></div>
    </div>
  </article>
  <section>
    <div>Galdieri Rent Olbia</div><div>Proprietario</div>
    ${campo}
    <div class="riga FkJOzc">${TASTI}</div>
  </section>
</div>

<script>
  const RECENSIONI = ${JSON.stringify(RECENSIONI)};
  const campo = document.getElementById("campo");
  let i = 0;
  function mostra() {
    if (i >= RECENSIONI.length) { document.getElementById("coda").textContent = "Nessuna recensione da gestire"; return; }
    const r = RECENSIONI[i];
    document.getElementById("contatore").textContent = (i + 1) + " di " + RECENSIONI.length + " recensioni";
    // Il nome PIÙ l'icona, come fa Google: è la trappola.
    document.getElementById("autore").innerHTML =
      r.autore + '<i class="google-symbols notranslate" aria-hidden="true">open_in_new</i>';
    document.getElementById("stelle").setAttribute("aria-label", r.stelle + " su 5 stelle");
    document.getElementById("testo-corto").textContent = r.testo;
    document.getElementById("testo-pieno").textContent = r.testoPieno || r.testo;
    campo.value = "";
    document.getElementById("invia").disabled = true;
  }
  document.getElementById("cta").addEventListener("click", () => {
    document.getElementById("lista").classList.add("nascosto");
    document.getElementById("coda").classList.remove("nascosto");
    mostra();
  });
  document.getElementById("ignora").addEventListener("click", () => { i++; mostra(); });
  campo.addEventListener("input", () => {
    document.getElementById("invia").disabled = campo.value.trim().length === 0;
  });
  document.getElementById("banner-chiudi").addEventListener("click", function () { this.remove(); });
  window.__pubblicato = false;
  document.getElementById("invia").addEventListener("click", () => { window.__pubblicato = true; });
</script>
`;
}

type Prova = { nome: string; controlli: [string, boolean][]; passi: string[] };

async function scenario(
  browser: Browser,
  titolo: string,
  { conTesto, stile, uscita }: { conTesto: boolean; stile: Stile; uscita: Uscita },
): Promise<Prova> {
  const page = await browser.newPage();
  await page.setContent(pagina(stile));

  const passi: string[] = [];
  const esito = await cercaNellaCoda(page, "D", "PROVA — non pubblicare", {
    log: (m) => passi.push(m),
    uscita,
    maxIgnora: 10,
    testoRecensione: conTesto ? TESTO_DB : undefined,
  });

  const pubblicato = await page.evaluate(
    () => (window as unknown as { __pubblicato: boolean }).__pubblicato,
  );
  const rimasto = await page.evaluate(() => {
    const c = document.getElementById("campo") as HTMLTextAreaElement | null;
    return c ? c.value : "(campo assente)";
  });
  const contatore = await page.evaluate(
    () => document.getElementById("contatore")?.textContent?.trim() ?? "",
  );
  await page.close();

  return {
    nome: titolo,
    passi,
    controlli: [
      ["è entrata nella coda", passi.some((p) => p.includes("sono entrato nella coda"))],
      ["ha premuto «Ignora» per girare", passi.some((p) => p.includes("recensione 2"))],
      // Il nome NON dev'essere inquinato dall'icona «open_in_new».
      ["ha letto il nome pulito (senza l'icona)", !/open_in_new/.test(esito.autore ?? "")],
      // Solo le righe della recensione: l'elenco diagnostico dei controlli
      // mostra apposta il testo grezzo, icone comprese.
      [
        "ha ripulito anche il testo della recensione",
        !passi
          .filter((p) => /^recensione \d|^la recensione trovata/.test(p))
          .some((p) => p.includes("open_in_new")),
      ],
      ["NON si è fermata su «Vito D'Amico»", esito.autore !== "Vito D'Amico"],
      ["è arrivata alla recensione di «D»", esito.autore === "D"],
      ["ha visto che è da 1 stella", passi.some((p) => p.includes("1 su 5 stelle"))],
      ["l'ha riconosciuta", esito.trovata === true],
      ["ha fatto 3 salti", passi.some((p) => p.includes("trovata dopo 3 «Ignora»"))],
      ["ha scritto", esito.scritto === true],
      ["NON ha pubblicato", pubblicato === false],
      conTesto
        ? ["ha riconosciuto il TESTO (anche se nascosto e tagliato)", passi.some((p) => p.includes("il testo"))]
        : ["ha riconosciuto per autore", passi.some((p) => p.includes("combacia l'autore"))],
      uscita === "ferma"
        ? ["si è fermata con la risposta scritta", rimasto.includes("PROVA")]
        : ["ha svuotato il campo uscendo", rimasto.trim() === "" || rimasto === "(campo assente)"],
      uscita === "ferma"
        ? ["NON ha premuto «Ignora» dopo aver scritto", contatore.startsWith("4 di 4")]
        : ["è passata oltre uscendo", !contatore.startsWith("4 di 4")],
    ],
  };
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const prove = [
    // Lo scenario che conta: il pop-up vero di Google, con tutte le trappole.
    await scenario(browser, "pop-up vero di Google, col testo dal database", {
      conTesto: true,
      stile: "popup",
      uscita: "ferma",
    }),
    await scenario(browser, "pop-up vero, col solo nome (se il testo non arriva)", {
      conTesto: false,
      stile: "popup",
      uscita: "ferma",
    }),
    // L'uscita che non lascia traccia: serve che continui a funzionare.
    await scenario(browser, "pop-up vero, uscita «sicura»: svuota e passa oltre", {
      conTesto: true,
      stile: "popup",
      uscita: "sicura",
    }),
    // Vista semplificata: tiene onesto il codice anche su un DOM diverso.
    await scenario(browser, "vista semplice (campo col placeholder)", {
      conTesto: true,
      stile: "semplice",
      uscita: "ferma",
    }),
  ];
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
