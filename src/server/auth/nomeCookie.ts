// Nome del cookie di sessione, in un file senza altre dipendenze: così può
// importarlo sia il codice server (sessione.ts) sia il middleware, che gira nel
// runtime edge e non può caricare i moduli node (Mongo, crypto).
export const COOKIE_SESSIONE = "gr_sessione";
