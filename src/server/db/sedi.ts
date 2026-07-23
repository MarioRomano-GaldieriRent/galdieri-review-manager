import { coll } from "./connessione";
import { registraAttivita, OPERATORE_SISTEMA } from "./attivita";

// Lettura e modifica delle sedi, per la pagina admin che compila i link di
// gestione recensioni su Google (la cascata dello spec §4). Le sedi nascono
// dal seed (ricavate dai ticket reali); qui si aggiungono solo i due campi
// link, e si importano/esportano in CSV per compilarle tutte in una volta.

export type Sede = {
  chiave: string;
  nome: string;
  tagFreshdesk: string;
  googleReviewsUrl: string;
  placeId: string;
};

type DocSede = {
  _id: string;
  nome: string;
  tagFreshdesk?: string;
  googleReviewsUrl?: string;
  placeId?: string;
};

function componi(d: DocSede): Sede {
  return {
    chiave: d._id,
    nome: d.nome,
    tagFreshdesk: d.tagFreshdesk ?? "",
    googleReviewsUrl: d.googleReviewsUrl ?? "",
    placeId: d.placeId ?? "",
  };
}

/** Tutte le sedi vere, in ordine di nome. Esclude la sentinella "". */
export async function leggiSedi(): Promise<Sede[]> {
  const righe = (await (
    await coll<DocSede>("sedi")
  )
    .find({ _id: { $ne: "" } })
    .sort({ nome: 1 })
    .toArray()) as DocSede[];
  return righe.map(componi);
}

export async function impostaLinkSede(
  chiave: string,
  googleReviewsUrl: string,
  placeId: string,
  operatoreId = OPERATORE_SISTEMA,
): Promise<boolean> {
  // La sentinella "" non è una sede vera: non deve mai ricevere un link.
  if (!chiave.trim()) return false;
  const r = await (
    await coll("sedi")
  ).updateOne(
    { _id: chiave },
    { $set: { googleReviewsUrl: googleReviewsUrl.trim(), placeId: placeId.trim() } },
  );
  if (r.matchedCount === 0) return false;
  await registraAttivita("sede.link", {
    operatoreId,
    oggettoTipo: "sede",
    oggettoId: chiave,
    dettaglio: `Link Google aggiornato: url=${googleReviewsUrl ? "sì" : "no"}, placeId=${placeId ? "sì" : "no"}`,
  });
  return true;
}

// ------------------------------------------------------------------- CSV

/** Un campo CSV: sempre fra virgolette, con le virgolette interne raddoppiate. */
function campo(v: string): string {
  return `"${(v ?? "").replace(/"/g, '""')}"`;
}

export function esportaSediCsv(sedi: Sede[]): string {
  const righe = [["chiave", "nome", "tagFreshdesk", "googleReviewsUrl", "placeId"].join(",")];
  for (const s of sedi) {
    righe.push(
      [s.chiave, s.nome, s.tagFreshdesk, s.googleReviewsUrl, s.placeId].map(campo).join(","),
    );
  }
  return righe.join("\r\n");
}

/** Parsing CSV minimale ma corretto su virgolette e virgole nei campi. */
function analizzaCsv(testo: string): string[][] {
  const righe: string[][] = [];
  let campoCorr = "";
  let riga: string[] = [];
  let inVirgolette = false;

  for (let i = 0; i < testo.length; i++) {
    const c = testo[i];
    if (inVirgolette) {
      if (c === '"') {
        if (testo[i + 1] === '"') {
          campoCorr += '"';
          i++;
        } else inVirgolette = false;
      } else campoCorr += c;
    } else if (c === '"') {
      inVirgolette = true;
    } else if (c === ",") {
      riga.push(campoCorr);
      campoCorr = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && testo[i + 1] === "\n") i++;
      riga.push(campoCorr);
      righe.push(riga);
      riga = [];
      campoCorr = "";
    } else campoCorr += c;
  }
  if (campoCorr !== "" || riga.length > 0) {
    riga.push(campoCorr);
    righe.push(riga);
  }
  return righe.filter((r) => r.some((c) => c.trim() !== ""));
}

export type EsitoImport = { aggiornate: number; ignorate: number; errori: string[] };

/**
 * Importa i link da CSV. Aggiorna solo googleReviewsUrl e placeId, e solo per
 * le sedi che già esistono (identificate dalla chiave, o dal nome se la chiave
 * manca). Non crea sedi nuove: quelle vengono dal codice.
 */
export async function importaSediCsv(
  csv: string,
  operatoreId = OPERATORE_SISTEMA,
): Promise<EsitoImport> {
  const righe = analizzaCsv(csv);
  if (righe.length === 0) return { aggiornate: 0, ignorate: 0, errori: ["File vuoto."] };

  const intestazione = righe[0].map((c) => c.trim().toLowerCase());
  const iChiave = intestazione.indexOf("chiave");
  const iNome = intestazione.indexOf("nome");
  const iUrl = intestazione.indexOf("googlereviewsurl");
  const iPlace = intestazione.indexOf("placeid");
  if (iUrl === -1 && iPlace === -1) {
    return { aggiornate: 0, ignorate: 0, errori: ["Manca la colonna googleReviewsUrl o placeId."] };
  }

  const esistenti = new Map<string, Sede>();
  const perNome = new Map<string, Sede>();
  for (const s of await leggiSedi()) {
    esistenti.set(s.chiave, s);
    perNome.set(s.nome.trim().toLowerCase(), s);
  }

  let aggiornate = 0;
  let ignorate = 0;
  const errori: string[] = [];

  for (const r of righe.slice(1)) {
    const chiave = (iChiave >= 0 ? r[iChiave] : "")?.trim() ?? "";
    const nome = (iNome >= 0 ? r[iNome] : "")?.trim() ?? "";
    const sede = esistenti.get(chiave) ?? perNome.get(nome.toLowerCase());
    if (!sede) {
      ignorate++;
      if (errori.length < 8) errori.push(`sede non trovata: «${chiave || nome}»`);
      continue;
    }
    const url = iUrl >= 0 ? (r[iUrl] ?? "").trim() : sede.googleReviewsUrl;
    const place = iPlace >= 0 ? (r[iPlace] ?? "").trim() : sede.placeId;
    await impostaLinkSede(sede.chiave, url, place, operatoreId);
    aggiornate++;
  }

  return { aggiornate, ignorate, errori };
}
