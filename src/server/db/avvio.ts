import { registraAvvio } from "./connessione";
import { semina } from "./seed";
import { travasaTutto } from "./travaso";

// Avvio del database: semina delle tabelle di riferimento e travaso dai vecchi
// file JSON. Gira una volta sola per processo, subito dopo le migrazioni.
//
// Questo modulo si importa PER EFFETTO COLLATERALE dai quattro moduli che
// fanno da porta d'ingresso ai dati (settings, rules, runs, translate):
// `import "@/server/db/avvio";`. È esplicito di proposito — un'inizializzazione
// che parte da sola dal fondo dello stack è comoda finché non si rompe, e
// allora non si capisce più chi l'abbia fatta partire.

registraAvvio((connessione) => {
  // La semina è idempotente e costa pochi millisecondi: rigirarla a ogni
  // avvio è ciò che tiene il database allineato al codice quando si aggiunge
  // una sede o un tipo di nodo.
  semina(connessione);
  travasaTutto();
});

export {};
