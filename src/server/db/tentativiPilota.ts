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
