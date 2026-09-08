import { linguaRisposta, nomeSembraItaliano } from "@/server/reviews/lingua";

//   npm run banco:lingua
//
// Banco della scelta di lingua per il "Grazie."/"Thank you." automatico.
// Niente rete, niente DB: gira sulle funzioni pure di reviews/lingua.ts.
//
// Il caso che ha motivato la modifica: una 5★ SENZA commento non ha nessun
// testo da cui riconoscere la lingua. Prima finiva sempre in italiano,
// chiunque l'avesse scritta. Ora, quando manca ogni altro segnale, decide il
// NOME del recensore.

type Caso = {
  titolo: string;
  nomeCliente: string;
  codiceAzure?: string;
  testo?: string;
  attesa: "it" | "altra";
};

const CASI: Caso[] = [
  // --- 5★ senza commento, Azure spento: decide il nome ---------------------
  { titolo: "Mario Rossi, 5★ senza commento", nomeCliente: "Mario Rossi", attesa: "it" },
  { titolo: "Giulia Bianchi, 5★ senza commento", nomeCliente: "Giulia Bianchi", attesa: "it" },
  { titolo: "Vito D'Amico, 5★ senza commento", nomeCliente: "Vito D'Amico", attesa: "it" },
  { titolo: "Antonio De Luca, 5★ senza commento (cognome composto)", nomeCliente: "Antonio De Luca", attesa: "it" },
  { titolo: "John Smith, 5★ senza commento", nomeCliente: "John Smith", attesa: "altra" },
  { titolo: "Carlos Garcia, 5★ senza commento (spagnoleggiante)", nomeCliente: "Carlos Garcia", attesa: "altra" },
  { titolo: "Hans Müller, 5★ senza commento (segno straniero)", nomeCliente: "Hans Müller", attesa: "altra" },
  { titolo: "Katarzyna Nowak, 5★ senza commento", nomeCliente: "Katarzyna Nowak", attesa: "altra" },
  { titolo: "«D» (una lettera), 5★ senza commento", nomeCliente: "D", attesa: "altra" },
  { titolo: "nome vuoto, 5★ senza commento", nomeCliente: "", attesa: "altra" },

  // --- il TESTO, quando c'è, vince sempre sul nome --------------------------
  {
    titolo: "John Smith ma scrive in italiano: vince il testo",
    nomeCliente: "John Smith",
    testo: "Personale gentilissimo e disponibile, macchina nuova e pulita, prezzo onesto. Consigliato davvero.",
    attesa: "it",
  },
  {
    titolo: "Mario Rossi ma scrive in inglese: vince il testo",
    nomeCliente: "Mario Rossi",
    testo: "Great service, very quick pick-up and the car was clean. Would definitely rent again with this company.",
    attesa: "altra",
  },

  // --- Azure, quando c'è, vince su tutto -------------------------------------
  {
    titolo: "nome straniero ma Azure dice italiano: vince Azure",
    nomeCliente: "John Smith",
    codiceAzure: "it",
    attesa: "it",
  },
  {
    titolo: "nome italiano ma Azure dice tedesco: vince Azure",
    nomeCliente: "Mario Rossi",
    codiceAzure: "de",
    attesa: "altra",
  },
];

let ko = 0;
for (const c of CASI) {
  const r = linguaRisposta(c.codiceAzure ?? "", c.testo ?? "", c.nomeCliente);
  const ok = r === c.attesa;
  if (!ok) ko++;
  console.log(`${ok ? "ok  " : "KO  "} ${c.titolo} → ${r} (atteso ${c.attesa})`);
}

console.log("\n--- nomeSembraItaliano da solo ---");
const NOMI: [string, boolean][] = [
  ["Mario Rossi", true],
  ["Giuseppe Esposito", true],
  ["Anna Maria Colombo", true],
  ["Vito D'Amico", true],
  ["Filippo De Santis", true],
  ["John Smith", false],
  ["Emily Johnson", false],
  ["Carlos Garcia", false],
  ["María López", false],
  ["Hans Müller", false],
  ["François Dupont", false],
  ["Katarzyna Nowak", false],
  ["", false],
  ["D", false],
  ["Al", false],
];
for (const [nome, atteso] of NOMI) {
  const r = nomeSembraItaliano(nome);
  const ok = r === atteso;
  if (!ok) ko++;
  console.log(`${ok ? "ok  " : "KO  "} «${nome}» → ${r} (atteso ${atteso})`);
}

console.log(ko === 0 ? "\nTUTTO A POSTO." : `\n${ko} CONTROLLI FALLITI.`);
process.exit(ko === 0 ? 0 : 1);
