import { agganciaPerCorpo } from "@/server/integrations/freshdesk";

//   npm run banco:aggancio
//
// Banco dell'AGGANCIO ticket ↔ recensione dal corpo del ticket. Niente rete:
// gira sulla funzione pura, con un corpo ricalcato su quello VERO del ticket
// di «D» (#59358), che è il caso che ha fatto scoprire il difetto:
//
//   il nome «D» è sotto le 3 lettere e per prudenza non aggancia mai; il testo
//   della recensione è nel corpo per intero («Commento:…») e nessuno lo
//   guardava. Risultato: ticket mai agganciato, mai classificato, mai chiuso.

/** Il corpo come lo lascia Freshdesk: HTML con entità, e la struttura Zapier. */
function corpo(nome: string, commento: string, stelle = 1): string {
  return `<div>Si trasmette per quanto di competenza.</div>
<div>From: no-reply@zapiermail.com &lt;no-reply@zapiermail.com&gt; on behalf of customer.care@galdierirent.it</div>
<div>Subject: NUOVA RECENSIONE GOOGLE Point aeroporto Olbia</div>
<div>Nome:${nome}</div>
<div>Commento:${commento}</div>
<div>Punteggio:${stelle} Stelle</div>
<div>ID: AbFvOqlDKBnbmi4giyuBMLKnrVp2vPZO7hsXumPAZn8r3ioqByvpqBg0N3IiQ7rzzYUu2jHZNhOl3w</div>`;
}

const TESTO_D =
  "ATTENTION AVOID LONG WAIT - 3 people in front of us and we have so far waited 1 hr 30 minutes. Still not at the desk.";
const ALTRO_TESTO = "Great service, quick pick-up and a clean car. Would rent again.";

const CORPO_D = corpo("D", TESTO_D);

type Caso = { nome: string; corpo: string; recensore: string; testo?: string; atteso: boolean; come?: RegExp };

const CASI: Caso[] = [
  {
    nome: "«D» col testo della recensione → aggancia dal TESTO",
    corpo: CORPO_D,
    recensore: "D",
    testo: TESTO_D,
    atteso: true,
    come: /testo della recensione/,
  },
  {
    nome: "«D» col testo in versione tradotta (non è nel corpo) → NON aggancia",
    corpo: CORPO_D,
    recensore: "D",
    testo: "ATTENZIONE EVITARE LUNGHE ATTESE - 3 persone davanti a noi e finora abbiamo aspettato 1 ora e 30 minuti.",
    atteso: false,
  },
  {
    nome: "«D» senza testo (5★ secca) → aggancia da «Nome:D Commento:»",
    corpo: CORPO_D,
    recensore: "D",
    atteso: true,
    come: /Nome:/,
  },
  {
    nome: "«D» col testo di un'ALTRA recensione → NON aggancia (decide il testo)",
    corpo: CORPO_D,
    recensore: "D",
    testo: ALTRO_TESTO,
    atteso: false,
  },
  {
    nome: "«Daniele» sul ticket di «D» → NON aggancia",
    corpo: CORPO_D,
    recensore: "Daniele",
    atteso: false,
  },
  {
    nome: "«Arthur Lavallée» sul corpo senza accento → aggancia dal NOME",
    corpo: corpo("Arthur Lavallee", "Tres bon service."),
    recensore: "Arthur Lavallée",
    atteso: true,
    come: /nome «Arthur Lavallée» trovato nel corpo$/,
  },
  {
    nome: "«Filip Antic» col testo tradotto ma nome nel corpo → aggancia dal NOME",
    corpo: corpo("Filip Antic", "Sve je bilo u redu."),
    recensore: "Filip Antic",
    testo: "Tutto è andato bene.",
    atteso: true,
    come: /nome «Filip Antic»/,
  },
  {
    nome: "«Al» con testo corto («Top») → aggancia da «Nome:Al Commento:»",
    corpo: corpo("Al", "Top"),
    recensore: "Al",
    testo: "Top",
    atteso: true,
    come: /Nome:/,
  },
  {
    nome: "«Al» sul ticket di «Alberto» → NON aggancia",
    corpo: corpo("Alberto", "Top"),
    recensore: "Al",
    atteso: false,
  },
  {
    nome: "testo con punteggiatura e entità diverse → aggancia lo stesso",
    corpo: corpo("D", "ATTENTION, AVOID LONG WAIT &#8211; 3 people in front of us and we have so far waited 1 hr 30 minutes &amp; counting!"),
    recensore: "D",
    testo: TESTO_D,
    atteso: true,
    come: /testo della recensione/,
  },
];

let ko = 0;
for (const c of CASI) {
  const r = agganciaPerCorpo(c.corpo, c.recensore, c.testo);
  const okEsito = r.ok === c.atteso;
  const okCome = !c.come || c.come.test(r.come);
  const ok = okEsito && okCome;
  if (!ok) ko++;
  console.log(`${ok ? "ok  " : "KO  "} ${c.nome}${r.ok ? ` — ${r.come}` : ""}`);
}
console.log(ko === 0 ? "\nTUTTO A POSTO." : `\n${ko} CONTROLLI FALLITI.`);
process.exit(ko === 0 ? 0 : 1);
