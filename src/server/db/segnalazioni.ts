import { coll } from "./connessione";
import { registraAttivita } from "./attivita";
import { testoRecensione, type Recensione } from "@/server/reviews/load";

// Segnalazioni all'amministratore: l'operatore incontra una recensione che non
// riesce a gestire, scrive cosa non va e la passa a chi può risolvere. Da quel
// momento la recensione esce dalla sua coda «Da approvare» — nascosta, non
// cancellata — e compare nel pannello Supervisione.
//
//   aperta   → in carico all'admin (nascosta all'operatore)
//   risolta  → l'admin ha sistemato; resta nascosta all'operatore
//   rimessa  → l'admin l'ha rimandata in coda: ricompare in «Da approvare»

export type StatoSegnalazione = "aperta" | "risolta" | "rimessa";

export type Segnalazione = {
  chiave: string;
  nomeCliente: string;
  stelle: number | null;
  sedeNome: string;
  testoRecensione: string;
  ricevutaIl: string;
  messaggioId: string;
  nota: string;
  segnalataIl: string;
  segnalataDa: number;
  stato: StatoSegnalazione;
  notaChiusura: string;
  chiusaIl: string | null;
  chiusaDa: number | null;
};

type DocSegn = {
  _id: string;
  nomeCliente: string;
  stelle: number | null;
  sedeNome: string;
  testoRecensione: string;
  ricevutaIl: Date;
  messaggioId: string;
  nota: string;
  segnalataIl: Date;
  segnalataDa: number;
  stato: StatoSegnalazione;
  notaChiusura: string;
  chiusaIl: Date | null;
  chiusaDa: number | null;
  aggiornataIl: Date;
};

async function segnalazioni() {
  return coll<DocSegn>("segnalazioni");
}

function componi(d: DocSegn): Segnalazione {
  return {
    chiave: d._id,
    nomeCliente: d.nomeCliente,
    stelle: d.stelle,
    sedeNome: d.sedeNome,
    testoRecensione: d.testoRecensione,
    ricevutaIl: d.ricevutaIl.toISOString(),
    messaggioId: d.messaggioId,
    nota: d.nota,
    segnalataIl: d.segnalataIl.toISOString(),
    segnalataDa: d.segnalataDa,
    stato: d.stato,
    notaChiusura: d.notaChiusura,
    chiusaIl: d.chiusaIl ? d.chiusaIl.toISOString() : null,
    chiusaDa: d.chiusaDa,
  };
}

/**
 * L'operatore segnala la recensione: voce «aperta» con la sua nota.
 *
 * UNA SOLA VOLTA. Se ce n'è già una APERTA per quella recensione non si fa
 * nulla e si torna `false`: senza questa guardia un doppio clic, un tasto
 * premuto su una pagina vecchia o un ritorno con «Indietro» riscrivevano la
 * segnalazione e — soprattutto — rimandavano la mail all'amministratore ogni
 * volta.
 *
 * La guardia è ATOMICA e sta nel database, non in un controllo prima della
 * scrittura: il filtro esclude le voci già aperte, quindi l'upsert è costretto
 * a inserire e sbatte contro l'unicità di `_id` (errore 11000). Due clic
 * simultanei non possono passare tutti e due, cosa che un «leggi e poi scrivi»
 * non garantirebbe.
 *
 * Una voce RISOLTA o RIMESSA IN CODA invece si può segnalare di nuovo: il
 * filtro la lascia passare e la voce riparte da zero (la storia resta nel
 * registro attività). È il caso di una recensione rimandata all'operatore che
 * continua a non essere lavorabile.
 */
export async function segnala(r: Recensione, nota: string, operatoreId: number): Promise<boolean> {
  const ora = new Date();
  try {
    await (await segnalazioni()).updateOne(
      { _id: r.chiave, stato: { $ne: "aperta" } },
      {
        $set: {
          nomeCliente: r.nome,
          stelle: r.stelle,
          sedeNome: r.sede,
          testoRecensione: testoRecensione(r),
          ricevutaIl: new Date(r.ricevutaIl),
          messaggioId: r.messaggioId,
          nota,
          segnalataIl: ora,
          segnalataDa: operatoreId,
          stato: "aperta",
          notaChiusura: "",
          chiusaIl: null,
          chiusaDa: null,
          aggiornataIl: ora,
        },
      },
      { upsert: true },
    );
  } catch (e) {
    // 11000 = chiave duplicata: esiste già una voce aperta per questa
    // recensione, ed è esattamente il caso che vogliamo bloccare.
    if ((e as { code?: number }).code === 11000) return false;
    throw e;
  }
  await registraAttivita("segnalazione.aperta", {
    operatoreId,
    oggettoTipo: "recensione",
    oggettoId: r.chiave,
    dettaglio: nota.slice(0, 200),
  });
  return true;
}

/** La segnalazione di una recensione, in qualunque stato. */
export async function leggiSegnalazione(chiave: string): Promise<Segnalazione | null> {
  const d = await (await segnalazioni()).findOne({ _id: chiave });
  return d ? componi(d) : null;
}

/** Chiavi da tenere FUORI da «Da approvare»: aperte e risolte (le rimesse tornano in coda). */
export async function chiaviSegnalate(): Promise<Set<string>> {
  const righe = await (await segnalazioni())
    .find({ stato: { $in: ["aperta", "risolta"] } }, { projection: { _id: 1 } })
    .toArray();
  return new Set(righe.map((d) => d._id));
}

export async function contaAperte(): Promise<number> {
  return (await segnalazioni()).countDocuments({ stato: "aperta" });
}

/** Quante ne sono arrivate in una finestra [dal, al), a prescindere da come stanno ora. */
export async function contaApertePeriodo(dal: Date, al: Date): Promise<number> {
  return (await segnalazioni()).countDocuments({ segnalataIl: { $gte: dal, $lt: al } });
}

/** Quante sono state CHIUSE (risolte o rimesse in coda) in una finestra [dal, al). */
export async function contaGestitePeriodo(dal: Date, al: Date): Promise<number> {
  return (await segnalazioni()).countDocuments({
    stato: { $in: ["risolta", "rimessa"] },
    chiusaIl: { $gte: dal, $lt: al },
  });
}

/** In carico all'admin, dalla più recente. */
export async function elencoAperte(): Promise<Segnalazione[]> {
  const righe = await (await segnalazioni()).find({ stato: "aperta" }).sort({ segnalataIl: -1 }).toArray();
  return righe.map(componi);
}

/** Risolte o rimesse in coda, dalla chiusura più recente. */
export async function elencoChiuse(limite = 50): Promise<Segnalazione[]> {
  const righe = await (await segnalazioni())
    .find({ stato: { $in: ["risolta", "rimessa"] } })
    .sort({ chiusaIl: -1 })
    .limit(limite)
    .toArray();
  return righe.map(componi);
}

/**
 * L'admin chiude la segnalazione: «risolta» (ha sistemato lui, la recensione
 * resta fuori dalla coda) o «rimessa» (torna all'operatore in «Da approvare»).
 * Solo una voce aperta si chiude: un doppio clic non riscrive la chiusura.
 */
export async function chiudiSegnalazione(
  chiave: string,
  esito: "risolta" | "rimessa",
  nota: string,
  operatoreId: number,
): Promise<void> {
  const ora = new Date();
  const r = await (await segnalazioni()).updateOne(
    { _id: chiave, stato: "aperta" },
    { $set: { stato: esito, notaChiusura: nota, chiusaIl: ora, chiusaDa: operatoreId, aggiornataIl: ora } },
  );
  if (r.matchedCount === 0) return;
  await registraAttivita(esito === "risolta" ? "segnalazione.risolta" : "segnalazione.rimessa", {
    operatoreId,
    oggettoTipo: "recensione",
    oggettoId: chiave,
    dettaglio: nota.slice(0, 200),
  });
}
