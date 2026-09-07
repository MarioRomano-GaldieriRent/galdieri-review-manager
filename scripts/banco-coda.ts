import { chromium, type Browser } from "playwright";
import { cercaNellaCoda } from "@/server/robot/google";

type Uscita = "sicura" | "ferma";

//   npm run robot:banco
//
// Banco di prova della coda: una finta pagina che imita la vista di Google
// (lista con il tasto «Rispondere a recensioni», poi la coda una recensione
// alla volta con «Ignora»). Serve a verificare che il codice VERO clicchi,
// entri, giri le recensioni con «Ignora» e scriva su quella giusta — senza
// toccare Google e senza login: gira in Chromium headless.
//
// Ha già ripagato il costo quattro volte. Ha scoperto che:
//  - dentro page.evaluate le funzioni con NOME rompono tutto sotto tsx
//    («__name is not defined»), e l'errore era pure inghiottito da un catch;
//  - contare gli elementi senza guardare se sono VISIBILI faceva risultare la
//    coda «già aperta» mentre si era ancora sulla lista;
//  - riconoscere la persona col solo nome è pericoloso: col cliente «D» si
//    combaciava con «Vito D'Amico» e si sarebbe scritto sotto la SUA
//    recensione — da lì il riconoscimento dal TESTO della recensione;
//  - se il campo di risposta non si riconosceva (nella coda vera è un
//    contenteditable senza placeholder) il metodo si fermava PRIMA di premere
//    «Ignora» nemmeno una volta: è lo scenario «markup vero» qui sotto.

type Recensione = { autore: string; testo: string };

const RECENSIONI: Recensione[] = [
  { autore: "Marco Rossi", testo: "Ottimo servizio, personale gentile." },
  // La trappola: col vecchio confronto «contiene», cercando «D» ci si fermava
  // qui e si scriveva sotto la recensione di un estraneo.
  { autore: "Vito D'Amico", testo: "Tutto bene, niente da dire." },
  { autore: "Daniele Bianchi", testo: "Tutto bene, D come sempre." },
  { autore: "D", testo: "Pessima esperienza al Point aeroporto di Olbia." },
];
const BERSAGLIO = RECENSIONI[3];

/**
 * I due tasti in fondo alla coda. In «reale» sono copiati dal DOM vero di
 * Google: <button> col testo dentro uno span annidato e un mucchio di classi
 * generate, «Rispondi» disabilitato finché non si scrive.
 */
function tasti(reale: boolean): string {
  if (!reale) {
    return `<button id="ignora">Ignora</button><button id="invia" disabled>Rispondi</button>`;
  }
  return `
    <button id="ignora" class="AeBiU-LgbsSe FwaX8 nq9VD P8Hxme" jscontroller="O626Fe" jsname="dmDvRc">
      <span class="XjoK4b"></span><span class="UTNHae"></span><span class="AeBiU-RLmnJb"></span>
      <span jsname="V67aGc" class="AeBiU-vQzf8d">Ignora</span><span jsname="UkTUqb"></span>
    </button>
    <button id="invia" class="UywwFc-LgbsSe FwaX8 P8Hxme" jscontroller="O626Fe" jsname="hrGhad" disabled>
      <span class="XjoK4b"></span><span class="MMvswb"><span class="OLCwg"></span></span>
      <span jsname="V67aGc" class="UywwFc-vQzf8d">Rispondi</span><span jsname="UkTUqb"></span>
    </button>`;
}

/** Il campo dove si scrive: con placeholder, o come nella coda vera. */
function campo(reale: boolean): string {
  return reale
    ? `<div id="campo" contenteditable="true" role="textbox" aria-label="Scrivi"></div>`
    : `<textarea id="campo" placeholder="Risposta pubblica"></textarea>`;
}

function pagina(reale: boolean): string {
  return `
<!doctype html><meta charset="utf-8"><title>finta Google</title>
<style>body{font-family:sans-serif;margin:20px} .riga{display:flex;gap:8px;margin-top:10px}
button{padding:8px 14px} .nascosto{display:none}
#campo[contenteditable]{border:1px solid #ccc;min-height:40px;padding:6px}</style>

<div id="lista">
  <h1>Recensioni della sede</h1>
  <p>Visualizzazione 1-10 di 348 recensioni</p>
  <div><b>Marco Rossi</b> — Ottimo servizio <button>Rispondi</button></div>
  <div><b>Vito D'Amico</b> — Tutto bene <button>Rispondi</button></div>
  <button id="banner-chiudi">Ignora</button>
  <!-- il tasto della coda: etichetta spezzata fra due span, come su Google -->
  <div id="cta" role="button" tabindex="0"><span>Rispondere a</span> <span>recensioni (4)</span></div>
</div>

<div id="coda" class="nascosto">
  <div id="riquadro">
    <div id="contatore"></div>
    <div id="autore"></div>
    <div id="stelle">★★★★★</div>
    <div id="testo"></div>
    ${campo(reale)}
    <div class="riga">${tasti(reale)}</div>
  </div>
</div>

<script>
  const RECENSIONI = ${JSON.stringify(RECENSIONI)};
  const campo = document.getElementById("campo");
  const leggiCampo = () => ("value" in campo ? campo.value : campo.textContent) || "";
  const svuotaCampo = () => { if ("value" in campo) campo.value = ""; else campo.textContent = ""; };
  let i = 0;
  function mostra() {
    if (i >= RECENSIONI.length) { document.getElementById("riquadro").textContent = "Nessuna recensione da gestire"; return; }
    document.getElementById("contatore").textContent = (i + 1) + " di " + RECENSIONI.length + " recensioni";
    document.getElementById("autore").textContent = RECENSIONI[i].autore;
    document.getElementById("testo").textContent = RECENSIONI[i].testo;
    svuotaCampo();
    document.getElementById("invia").disabled = true;
  }
  document.getElementById("cta").addEventListener("click", () => {
    document.getElementById("lista").classList.add("nascosto");
    document.getElementById("coda").classList.remove("nascosto");
    mostra();
  });
  document.getElementById("ignora").addEventListener("click", () => { i++; mostra(); });
  campo.addEventListener("input", () => {
    document.getElementById("invia").disabled = leggiCampo().trim().length === 0;
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
  { conTesto, reale, uscita }: { conTesto: boolean; reale: boolean; uscita: Uscita },
): Promise<Prova> {
  const page = await browser.newPage();
  await page.setContent(pagina(reale));

  const passi: string[] = [];
  const esito = await cercaNellaCoda(page, "D", "PROVA — non pubblicare", {
    log: (m) => passi.push(m),
    uscita,
    maxIgnora: 10,
    testoRecensione: conTesto ? BERSAGLIO.testo : undefined,
  });

  const pubblicato = await page.evaluate(
    () => (window as unknown as { __pubblicato: boolean }).__pubblicato,
  );
  const rimasto = await page.evaluate(() => {
    const c = document.getElementById("campo");
    if (!c) return "(campo assente)";
    // textarea o contenteditable: il testo sta in due posti diversi.
    const v = (c as HTMLTextAreaElement).value;
    return (typeof v === "string" ? v : c.textContent) || "";
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
      ["ha cliccato il tasto della coda", passi.some((p) => p.includes("cliccato il candidato"))],
      // Il cuore della prova: deve GIRARE le recensioni, non fermarsi subito.
      ["ha premuto «Ignora» per girare", passi.some((p) => p.includes("recensione 2"))],
      ["NON si è fermata su «Vito D'Amico»", esito.autore !== "Vito D'Amico"],
      ["NON si è fermata su «Daniele Bianchi»", esito.autore !== "Daniele Bianchi"],
      ["è arrivata alla recensione di «D»", passi.some((p) => p.includes("recensione 4"))],
      ["l'ha riconosciuta", esito.trovata === true],
      ["ha fatto 3 salti", passi.some((p) => p.includes("trovata dopo 3 «Ignora»"))],
      ["ha scritto", esito.scritto === true],
      ["NON ha pubblicato", pubblicato === false],
      uscita === "ferma"
        ? // Il tasto di prova si deve FERMARE lì: risposta scritta e recensione
          // ancora a schermo, perché una persona controlli che sia la sua.
          ["si è fermata con la risposta scritta", rimasto.includes("PROVA")]
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
    await scenario(browser, "col testo della recensione (come il tasto sulla card)", {
      conTesto: true,
      reale: false,
      uscita: "ferma",
    }),
    await scenario(browser, "col solo nome (se il testo non arriva)", {
      conTesto: false,
      reale: false,
      uscita: "ferma",
    }),
    // Lo scenario che riproduce il blocco vero: tasti col testo dentro span
    // annidati e campo contenteditable SENZA placeholder.
    await scenario(browser, "markup vero di Google (campo senza placeholder)", {
      conTesto: true,
      reale: true,
      uscita: "ferma",
    }),
    // L'uscita che non lascia traccia: serve che continui a funzionare, perché
    // è quella che il robot usa quando NON deve far restare niente a schermo.
    await scenario(browser, "uscita «sicura»: svuota e passa oltre", {
      conTesto: true,
      reale: true,
      uscita: "sicura",
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
