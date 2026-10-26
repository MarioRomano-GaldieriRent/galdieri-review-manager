import { coll } from "./connessione";

// I tentativi AUTOMATICI falliti del pilota, per recensione e per fase.
//
// Regola decisa da Mario il 22/9/2026 per le negative 1-2★: se un passo del
// pilota non riesce, al giro dopo ci riprova da solo; se non riesce nemmeno la
// seconda volta la recensione passa in Supervisione. Qui si conta.
//
// Dopo MAX_TENTATIVI l'automazione CONSEGNA la recensione alle persone per
// sempre: il pilota non la ritocca, e la home la mostra in «Da approvare» anche
// col pilota acceso. Senza questo, una recensione rimessa in coda dalla
// Supervisione sarebbe tornata nascosta (regola in automatico) e ignorata dal
// pilota (tentativi esauriti): sparita da tutte e due le parti.
//
// Un documento per recensione e fase (_id = «fase:chiave»). Non si cancella
// mai: è anche la traccia del perché è andata in Supervisione.

export type FasePilota = "inoltro" | "pubblicazione";

/** Due tentativi, poi Supervisione. */
export const MAX_TENTATIVI = 2;

/**
 * Quanto si aspetta prima di RIPROVARE la stessa recensione.
 *
 * Senza questa attesa il secondo tentativo partiva al giro dopo, cinque minuti
 * più tardi, nelle stesse condizioni del primo: due fallimenti identici e la
 * recensione in Supervisione in dieci minuti. È quello che è successo a Trisha
 * Kelland, Dominik Ull e Borja Barron, che hanno due errori «non trovata»
 * uguali.
 *
 * Un'ora più tardi invece la ricerca su Google spesso va: Bruno Guerriero è
 * fallito alle 09:06 ed è stato pubblicato alle 09:39, Fabio Dimatteo è fallito
 * il sabato ed è passato il lunedì senza che nessuno cambiasse niente.
 */
export const PAUSA_FRA_TENTATIVI_MS = 60 * 60 * 1000;

/** Quanti messaggi d'errore si tengono per voce: gli ultimi, bastano per capire. */
const ERRORI_TENUTI = 5;

type DocTentativi = {
  _id: string;
  chiave: string;
  fase: FasePilota;
  n: number;
  errori: { il: Date; messaggio: string }[];
  ultimoIl: Date;
};

async function tentativi() {
  return coll<DocTentativi>("pilota_tentativi");
}

const idDi = (fase: FasePilota, chiave: string) => `${fase}:${chiave}`;

/**
 * Registra un tentativo fallito e ritorna a che punto si è: quanti ne sono
 * falliti finora (questo compreso) e i loro motivi, dal più vecchio.
 */
export async function registraTentativoFallito(
  fase: FasePilota,
  chiave: string,
  messaggio: string,
): Promise<{ n: number; errori: string[] }> {
  const ora = new Date();
  const d = await (
    await tentativi()
  ).findOneAndUpdate(
    { _id: idDi(fase, chiave) },
    {
      $inc: { n: 1 },
      $set: { chiave, fase, ultimoIl: ora },
      $push: {
        errori: {
          $each: [{ il: ora, messaggio: messaggio.slice(0, 500) }],
          $slice: -ERRORI_TENUTI,
        },
      },
    },
    { upsert: true, returnDocument: "after" },
  );
  return { n: d?.n ?? 1, errori: (d?.errori ?? []).map((e) => e.messaggio) };
}

/**
 * Le chiavi su cui l'automazione ha finito i tentativi, in una fase qualunque:
 * da qui in poi sono lavoro per una persona.
 */
export async function chiaviAutomazioneEsaurita(): Promise<Set<string>> {
  const righe = await (
    await tentativi()
  )
    .find({ n: { $gte: MAX_TENTATIVI } }, { projection: { chiave: 1 } })
    .toArray();
  return new Set(righe.map((d) => d.chiave));
}

/**
 * Azzera i tentativi di una recensione: l'automazione può riprovare da capo.
 *
 * La chiama «Rimetti in coda» della Supervisione. Senza, una recensione passata
 * alle persone dopo due fallimenti restava fuori dall'automazione per sempre, e
 * rimetterla in coda non serviva a niente: il pilota la ignorava. Invece
 * rimetterla in coda è proprio il gesto con cui si dice «riprova» — e sui casi
 * di «non trovata» riprovare funziona.
 *
 * Cancella le voci invece di mettere il contatore a zero: lo schema vuole `n`
 * almeno 1 (giusto: zero fallimenti non è una voce di fallimento), e un
 * aggiornamento a zero verrebbe rifiutato dal validator. Il perché la
 * recensione era finita in Supervisione resta scritto nella segnalazione, che
 * porta tutti i motivi.
 */
export async function azzeraTentativi(chiave: string): Promise<void> {
  await (await tentativi()).deleteMany({ chiave });
}

/**
 * Le chiavi che in questa fase hanno fallito TROPPO DI RECENTE: questo giro le
 * salta, il prossimo tentativo arriva dopo PAUSA_FRA_TENTATIVI_MS.
 *
 * Non sono un fallimento in più: la recensione resta in coda al pilota, e il
 * conto dei tentativi non si muove finché non si riprova davvero.
 */
export async function chiaviDaAspettare(
  fase: FasePilota,
  ora: Date = new Date(),
): Promise<Set<string>> {
  const righe = await (
    await tentativi()
  )
    .find(
      {
        fase,
        n: { $lt: MAX_TENTATIVI },
        ultimoIl: { $gt: new Date(ora.getTime() - PAUSA_FRA_TENTATIVI_MS) },
      },
      { projection: { chiave: 1 } },
    )
    .toArray();
  return new Set(righe.map((d) => d.chiave));
}
