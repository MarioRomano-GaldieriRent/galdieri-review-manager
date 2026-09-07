import { chromium } from "playwright";
import { cercaNellaCoda } from "@/server/robot/google";

//   npm run robot:banco
//
// Banco di prova della coda: una finta pagina che imita la vista di Google
// (lista con il tasto «Rispondere a recensioni», poi la coda una recensione
// alla volta con «Ignora»). Serve a verificare che il codice VERO clicchi,
// entri, salti fino all'autore giusto e scriva lì — senza toccare Google e
// senza bisogno del login: gira in Chromium headless su una pagina finta.
//
// Ha già ripagato il costo due volte: ha scoperto che dentro page.evaluate le
// funzioni con NOME rompono tutto sotto tsx («__name is not defined»), e che
// contare gli elementi senza guardare se sono VISIBILI faceva risultare la
// coda «già aperta» mentre si era ancora sulla lista.

const PAGINA = `
<!doctype html><meta charset="utf-8"><title>finta Google</title>
<style>body{font-family:sans-serif;margin:20px} .riga{display:flex;gap:8px;margin-top:10px}
button{padding:8px 14px} .nascosto{display:none}</style>

<div id="lista">
  <h1>Recensioni della sede</h1>
  <p>Visualizzazione 1-10 di 348 recensioni</p>
  <div><b>Marco Rossi</b> — Ottimo servizio <button>Rispondi</button></div>
  <div><b>Daniele Bianchi</b> — Tutto bene <button>Rispondi</button></div>
  <button id="banner-chiudi">Ignora</button>
  <!-- il tasto della coda: etichetta spezzata fra due span, come su Google -->
  <div id="cta" role="button" tabindex="0"><span>Rispondere a</span> <span>recensioni (3)</span></div>
</div>

<div id="coda" class="nascosto">
  <div id="riquadro">
    <div id="contatore"></div>
    <div id="autore"></div>
    <div id="stelle">★★★★★</div>
    <div id="testo"></div>
    <textarea id="campo" placeholder="Risposta pubblica"></textarea>
    <div class="riga">
      <button id="ignora">Ignora</button>
      <button id="invia" disabled>Rispondi</button>
    </div>
  </div>
</div>

<script>
  const RECENSIONI = [
    { autore: "Marco Rossi", testo: "Ottimo servizio, personale gentile." },
    { autore: "Daniele Bianchi", testo: "Tutto bene, D come sempre." },
    { autore: "D", testo: "Pessima esperienza al Point aeroporto." },
  ];
  let i = 0;
  function mostra() {
    if (i >= RECENSIONI.length) { document.getElementById("riquadro").textContent = "Nessuna recensione da gestire"; return; }
    document.getElementById("contatore").textContent = (i + 1) + " di " + RECENSIONI.length + " recensioni";
    document.getElementById("autore").textContent = RECENSIONI[i].autore;
    document.getElementById("testo").textContent = RECENSIONI[i].testo;
    document.getElementById("campo").value = "";
    document.getElementById("invia").disabled = true;
  }
  document.getElementById("cta").addEventListener("click", () => {
    document.getElementById("lista").classList.add("nascosto");
    document.getElementById("coda").classList.remove("nascosto");
    mostra();
  });
  document.getElementById("ignora").addEventListener("click", () => { i++; mostra(); });
  document.getElementById("campo").addEventListener("input", (e) => {
    document.getElementById("invia").disabled = e.target.value.trim().length === 0;
  });
  document.getElementById("banner-chiudi").addEventListener("click", function () { this.remove(); });
  window.__pubblicato = false;
  document.getElementById("invia").addEventListener("click", () => { window.__pubblicato = true; });
</script>
`;

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent(PAGINA);

  const passi: string[] = [];
  const esito = await cercaNellaCoda(page, "D", "PROVA — non pubblicare", {
    log: (m) => passi.push(m),
    uscita: "sicura",
    maxIgnora: 10,
  });

  console.log("--- passo-passo ---");
  passi.forEach((p, n) => console.log(String(n + 1).padStart(2) + ". " + p));
  console.log("\n--- esito ---");
  console.log(
    "trovata:",
    esito.trovata,
    "| scritto:",
    esito.scritto,
    "| autore:",
    JSON.stringify(esito.autore),
  );
  console.log("dettaglio:", esito.dettaglio);

  const pubblicato = await page.evaluate(
    () => (window as unknown as { __pubblicato: boolean }).__pubblicato,
  );
  const testoFinale = await page.evaluate(
    () =>
      (document.getElementById("campo") as HTMLTextAreaElement | null)?.value ?? "(campo assente)",
  );

  const attesi: [string, boolean][] = [
    ["è entrata nella coda", passi.some((p) => p.includes("sono entrato nella coda"))],
    ["ha cliccato il tasto della coda", passi.some((p) => p.includes("cliccato il candidato"))],
    [
      "NON ha scambiato «Daniele» per «D»",
      !passi.some((p) => p.includes("«D» combacia") && p.includes("dopo 0")),
    ],
    ["ha trovato l'autore «D»", esito.trovata === true && esito.autore === "D"],
    ["ha scritto", esito.scritto === true],
    ["NON ha pubblicato", pubblicato === false],
    ["ha svuotato il campo uscendo", testoFinale === "" || testoFinale === "(campo assente)"],
  ];
  console.log("\n--- controlli ---");
  let ko = 0;
  for (const [che, ok] of attesi) {
    if (!ok) ko++;
    console.log(`${ok ? "ok  " : "KO  "} ${che}`);
  }
  await browser.close();
  console.log(ko === 0 ? "\nTUTTO A POSTO." : `\n${ko} CONTROLLI FALLITI.`);
  process.exit(ko === 0 ? 0 : 1);
})().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.stack : e);
  process.exit(2);
});
