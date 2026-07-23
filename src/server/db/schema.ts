import type { Db, Document, IndexDescription } from "mongodb";
import { CATALOGO_IMPOSTAZIONI } from "./seed";

// ---------------------------------------------------------------------------
// Schema del database MongoDB: forma dei documenti (validator), indici e viste.
//
// Non ci sono migrazioni SQL: si dichiara lo stato desiderato e applicaSchema()
// lo rende vero a ogni avvio, in modo idempotente. I validator fanno il lavoro
// che in SQLite facevano STRICT, i CHECK e alcuni trigger. Tre cose però il
// motore non può più garantire e restano affidate al codice: l'immutabilità
// delle versioni di regola, quella dello storico impostazioni, e l'integrità
// referenziale (vedi scripts/verifica-db.ts). È il costo, messo per iscritto,
// di un mongod condiviso e senza autenticazione.
// ---------------------------------------------------------------------------

/** I cinque segreti, generati dal catalogo: mai scritti a mano nel validator. */
const SEGRETI = CATALOGO_IMPOSTAZIONI.filter((c) => c.segreto).map((c) => c.chiave);

// Frammenti riutilizzati -----------------------------------------------------
const stringa = { bsonType: "string" };
const stringaOFalsa = { bsonType: "string" }; // ammette anche ""
const boolo = { bsonType: "bool" };
const dataO = { bsonType: ["date", "null"] };
const stringaO = { bsonType: ["string", "null"] };
const sha1 = { bsonType: "string", pattern: "^[0-9a-f]{40}$" };

type DefColl = { nome: string; validator: Document; indici: IndexDescription[] };

export const COLLEZIONI: DefColl[] = [
  {
    nome: "recensioni",
    validator: {
      $and: [
        {
          $jsonSchema: {
            bsonType: "object",
            additionalProperties: false,
            required: [
              "_id",
              "origine",
              "nomeCliente",
              "ricevutaIl",
              "ricevutaIlLocale",
              "primaVistaIl",
              "ultimaVistaIl",
              "haTesto",
              "archiviata",
              "haRisposta",
              "risolto",
              "sede",
              "annoMese",
              "dataLocale",
              "oraLocale",
              "settimanaIso",
              "giornoSettimana",
            ],
            properties: {
              _id: { bsonType: "string", minLength: 1 },
              origine: { enum: ["google", "trustpilot"] },
              messaggioId: stringaOFalsa,
              oggetto: stringaOFalsa,
              etichettaId: stringaO,
              nomeCliente: stringa,
              stelle: { bsonType: ["int", "null"], minimum: 1, maximum: 5 },
              punteggioTesto: stringaOFalsa,
              testoOriginale: stringaOFalsa,
              testoItaliano: stringaO,
              ingleseDiGoogle: stringaOFalsa,
              giaItaliano: boolo,
              lingua: stringaO,
              sede: {
                bsonType: "object",
                required: ["chiave", "nome"],
                properties: {
                  chiave: stringaOFalsa,
                  nome: stringa,
                  tagFreshdesk: stringaOFalsa,
                },
              },
              numeroMessaggi: { bsonType: "int", minimum: 0 },
              haRisposta: boolo,
              risolto: boolo,
              ricevutaIl: { bsonType: "date" },
              primaVistaIl: { bsonType: "date" },
              ultimaVistaIl: { bsonType: "date" },
              rispostaRilevataIl: dataO,
              risoltoRilevatoIl: dataO,
              archiviataIl: dataO,
              // Orologio da parete: STRINGA. Il pattern impedisce che ci finisca
              // una Date o un ISO con la Z, che rimetterebbe il fuso in mezzo.
              ricevutaIlLocale: {
                bsonType: "string",
                pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}$",
              },
              annoMese: { bsonType: "string", pattern: "^\\d{4}-\\d{2}$" },
              dataLocale: { bsonType: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
              settimanaIso: { bsonType: "string", pattern: "^\\d{4}-W\\d{2}$" },
              giornoSettimana: { bsonType: "int", minimum: 0, maximum: 6 },
              oraLocale: { bsonType: "int", minimum: 0, maximum: 23 },
              haTesto: boolo,
              archiviata: boolo,
              motivoArchiviazione: stringaOFalsa,
              testoTroncato: boolo,
              impronta: stringaO,
            },
          },
        },
        // Le ex colonne GENERATED: il motore non le calcola, ma sa dire di no
        // se sono incoerenti con ricevutaIlLocale.
        {
          $expr: {
            $and: [
              { $eq: ["$annoMese", { $substrBytes: ["$ricevutaIlLocale", 0, 7] }] },
              { $eq: ["$dataLocale", { $substrBytes: ["$ricevutaIlLocale", 0, 10] }] },
              { $eq: ["$oraLocale", { $toInt: { $substrBytes: ["$ricevutaIlLocale", 11, 2] } }] },
              { $eq: ["$archiviata", { $ne: [{ $ifNull: ["$archiviataIl", null] }, null] }] },
            ],
          },
        },
      ],
    },
    indici: [
      { key: { ricevutaIlLocale: -1 }, name: "i_recensioni_ricevuta" },
      { key: { archiviata: 1, ricevutaIl: -1 }, name: "i_recensioni_coda" },
      { key: { annoMese: 1 }, name: "i_recensioni_anno_mese" },
      {
        key: { settimanaIso: 1 },
        name: "i_recensioni_settimana",
        partialFilterExpression: { settimanaIso: { $gt: "" } },
      },
      { key: { "sede.chiave": 1, ricevutaIlLocale: -1 }, name: "i_recensioni_sede" },
      { key: { stelle: 1, ricevutaIlLocale: -1 }, name: "i_recensioni_stelle" },
      { key: { stelle: 1, haTesto: 1 }, name: "i_recensioni_stelle_testo" },
      { key: { lingua: 1 }, name: "i_recensioni_lingua" },
      { key: { etichettaId: 1, ricevutaIlLocale: -1 }, name: "i_recensioni_etichetta" },
      { key: { origine: 1, ricevutaIlLocale: -1 }, name: "i_recensioni_origine" },
      {
        key: { impronta: 1 },
        name: "i_recensioni_impronta",
        partialFilterExpression: { impronta: { $type: "string" } },
      },
    ],
  },

  {
    nome: "sedi",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        additionalProperties: false,
        required: ["_id", "nome", "tagFreshdesk", "creataIl"],
        properties: {
          _id: { bsonType: "string" }, // "" ammesso: è la sentinella
          nome: { bsonType: "string", minLength: 1 },
          tagFreshdesk: stringaOFalsa,
          // Per la coda di pubblicazione manuale: l'URL di gestione recensioni
          // della sede su Google (fallback affidabile) e il place_id, da cui
          // costruire il link quando l'URL non c'è. Entrambi opzionali: le sedi
          // esistenti non li hanno finché l'admin non li compila.
          googleReviewsUrl: stringaOFalsa,
          placeId: stringaOFalsa,
          creataIl: { bsonType: "date" },
        },
      },
    },
    indici: [],
  },

  {
    nome: "lingue",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        additionalProperties: false,
        required: ["_id", "nome", "italiana"],
        properties: { _id: stringa, nome: stringa, italiana: boolo },
      },
    },
    indici: [],
  },

  {
    nome: "tipi_azione",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        additionalProperties: false,
        required: ["_id", "servizio", "titolo", "scrittura"],
        properties: {
          _id: stringa,
          servizio: { enum: ["freshdesk", "google", "email", "sistema"] },
          titolo: stringa,
          scrittura: boolo,
        },
      },
    },
    indici: [],
  },

  {
    nome: "operatori",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        additionalProperties: false,
        required: ["_id", "chiave", "nome", "tipo", "attivo", "diSistema", "creatoIl"],
        properties: {
          _id: { bsonType: "int" },
          chiave: { bsonType: "string", minLength: 1 },
          nome: stringa,
          email: stringaO,
          tipo: { enum: ["sistema", "persona", "servizio"] },
          ruolo: stringaOFalsa,
          attivo: boolo,
          diSistema: boolo,
          creatoIl: { bsonType: "date" },
          disattivatoIl: dataO,
        },
      },
    },
    indici: [{ key: { chiave: 1 }, name: "i_operatori_chiave", unique: true }],
  },

  {
    nome: "agenti_freshdesk",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        additionalProperties: false,
        required: ["_id", "nome", "attivo", "aggiornatoIl"],
        properties: {
          _id: stringa,
          nome: stringa,
          email: stringaO,
          gruppo: stringaOFalsa,
          attivo: boolo,
          operatoreId: { bsonType: ["int", "null"] },
          aggiornatoIl: { bsonType: "date" },
        },
      },
    },
    indici: [
      {
        key: { operatoreId: 1 },
        name: "i_agenti_operatore",
        partialFilterExpression: { operatoreId: { $type: "number" } },
      },
    ],
  },

  {
    nome: "registro_attivita",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        additionalProperties: false,
        required: ["_id", "quando", "operatoreId", "azione"],
        properties: {
          _id: { bsonType: "objectId" },
          quando: { bsonType: "date" },
          operatoreId: { bsonType: "int" },
          azione: { bsonType: "string", minLength: 1 },
          oggettoTipo: stringaO,
          oggettoId: stringaO,
          dettaglio: stringaOFalsa,
        },
      },
    },
    indici: [
      { key: { quando: -1 }, name: "i_attivita_quando" },
      {
        key: { oggettoTipo: 1, oggettoId: 1, quando: -1 },
        name: "i_attivita_oggetto",
        partialFilterExpression: { oggettoTipo: { $type: "string" } },
      },
    ],
  },

  {
    nome: "sincronizzazioni",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        additionalProperties: false,
        required: ["_id", "iniziataIl", "esito"],
        properties: {
          _id: { bsonType: "objectId" },
          iniziataIl: { bsonType: "date" },
          terminataIl: dataO,
          etichettaId: stringaO,
          messaggiLetti: { bsonType: "int", minimum: 0 },
          messaggiInterpretati: { bsonType: "int", minimum: 0 },
          messaggiScartati: { bsonType: "int", minimum: 0 },
          recensioniViste: { bsonType: "int", minimum: 0 },
          recensioniNuove: { bsonType: "int", minimum: 0 },
          recensioniAggiornate: { bsonType: "int", minimum: 0 },
          recensioniRifiutate: { bsonType: "int", minimum: 0 },
          esito: { enum: ["ok", "errore"] },
          errore: stringaO,
        },
      },
    },
    indici: [{ key: { iniziataIl: -1, _id: -1 }, name: "i_sincronizzazioni_data" }],
  },

  {
    nome: "regole",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        additionalProperties: false,
        required: ["_id", "regole", "aggiornateIl"],
        properties: {
          _id: { enum: ["correnti"] },
          aggiornateIl: { bsonType: "date" },
          aggiornateDa: { bsonType: "int" },
          regole: { bsonType: "array" },
        },
      },
    },
    indici: [],
  },

  {
    nome: "regole_versioni",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        additionalProperties: false,
        required: [
          "_id",
          "regolaId",
          "numero",
          "nome",
          "attiva",
          "condizione",
          "azioni",
          "impronta",
          "sigillo",
          "tipoModifica",
          "origine",
          "creataIl",
          "creataDa",
        ],
        properties: {
          _id: { bsonType: "int", minimum: 1 },
          regolaId: { bsonType: "string", minLength: 1 },
          numero: { bsonType: "int", minimum: 1 },
          nome: stringa,
          attiva: boolo,
          condizione: { bsonType: "object" },
          azioni: { bsonType: "array" },
          impronta: { bsonType: "string", pattern: "^[0-9a-f]{40}$" },
          sigillo: sha1,
          tipoModifica: { enum: ["creazione", "contenuto", "stato", "ripristino"] },
          origine: { enum: ["iniziale", "interfaccia", "ripristino", "importazione"] },
          nota: stringaOFalsa,
          creataIl: { bsonType: "date" },
          creataDa: { bsonType: "int" },
        },
      },
    },
    indici: [
      { key: { regolaId: 1, numero: -1 }, name: "i_versioni_regola", unique: true },
      { key: { creataIl: -1, _id: -1 }, name: "i_versioni_data" },
      { key: { impronta: 1, regolaId: 1 }, name: "i_versioni_impronta" },
    ],
  },

  {
    nome: "esecuzioni",
    validator: {
      $and: [
        {
          $jsonSchema: {
            bsonType: "object",
            additionalProperties: false,
            required: [
              "_id",
              "quando",
              "modo",
              "esito",
              "regolaId",
              "regolaNome",
              "recensioneChiave",
              "nodi",
              "annullata",
              "archiviata",
            ],
            properties: {
              _id: { bsonType: "string", minLength: 1 },
              quando: { bsonType: "date" },
              modo: { enum: ["simulazione", "reale"] },
              esito: { enum: ["ok", "errore"] },
              regolaId: { bsonType: "string", minLength: 1 },
              regolaNome: stringa,
              regolaVersioneId: { bsonType: ["int", "null"] },
              operatoreId: { bsonType: "int" },
              recensioneChiave: { bsonType: "string", minLength: 1 },
              recensioneNome: stringaOFalsa,
              recensioneStelle: { bsonType: ["int", "null"], minimum: 1, maximum: 5 },
              recensioneSede: stringaOFalsa,
              recensioneTesto: stringaOFalsa,
              testoModificato: boolo,
              durataMs: { bsonType: "int", minimum: 0 },
              nodi: { bsonType: "array" },
              scostamenti: { bsonType: "array" },
              annullata: boolo,
              annullataIl: dataO,
              archiviata: boolo,
              archiviataIl: dataO,
            },
          },
        },
        // La somma delle durate dei nodi deve tornare: se non torna, non tornava
        // nemmeno il dato di partenza.
        { $expr: { $eq: ["$durataMs", { $sum: "$nodi.durataMs" }] } },
      ],
    },
    indici: [
      {
        key: { quando: -1, _id: -1 },
        name: "i_esecuzioni_quando",
        partialFilterExpression: { annullata: false, archiviata: false },
      },
      {
        key: { recensioneChiave: 1, quando: -1 },
        name: "i_esecuzioni_recensione",
        partialFilterExpression: { annullata: false },
      },
      { key: { regolaId: 1, quando: -1 }, name: "i_esecuzioni_regola" },
      { key: { modo: 1, esito: 1, quando: -1 }, name: "i_esecuzioni_modo_esito" },
      {
        key: { regolaVersioneId: 1 },
        name: "i_esecuzioni_versione",
        partialFilterExpression: { regolaVersioneId: { $type: "number" } },
      },
      { key: { "nodi.tipo": 1, "nodi.stato": 1 }, name: "i_esecuzioni_nodi_tipo_stato" },
      { key: { "nodi.tipo": 1, "nodi.messaggio": 1 }, name: "i_esecuzioni_nodi_tipo_msg" },
    ],
  },

  {
    // Coda di pubblicazione manuale delle risposte su Google.
    //
    // Finché l'API Google non è attiva, la risposta la pubblica una persona
    // sull'interfaccia di Google. Un documento per recensione tiene lo stato di
    // quel passaggio. Gli stati sono tre, più semplici dei cinque dello spec:
    //   approvata  — risposta pronta, da incollare su Google (spec: "approvata")
    //   pubblicata — segnata come pubblicata, in attesa del ricontrollo a +24h
    //                (spec: "pubblicata" + "da_verificare", qui uniti)
    //   verificata — confermata online e chiusa (spec: "chiusa")
    // "in_pubblicazione" (presa in carico) non serve: un solo operatore, un
    // clic, nessuna presa in carico concorrente da coordinare.
    nome: "pubblicazioni",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        additionalProperties: false,
        required: [
          "_id",
          "origine",
          "stato",
          "testoRisposta",
          "nomeCliente",
          "photoChecked",
          "ripubblicazioni",
          "freshdeskEsito",
          "freshdeskTentativi",
          "approvataIl",
          "approvataDa",
          "creataIl",
          "aggiornataIl",
        ],
        properties: {
          _id: { bsonType: "string", minLength: 1 }, // = recensioneChiave
          origine: { enum: ["google", "trustpilot"] },
          stato: { enum: ["approvata", "pubblicata", "verificata"] },
          testoRisposta: { bsonType: "string", minLength: 1 },
          lingua: stringaO,
          // Denormalizzati per mostrare la coda senza ricomporre la recensione.
          nomeCliente: stringa,
          stelle: { bsonType: ["int", "null"], minimum: 1, maximum: 5 },
          sedeChiave: stringaOFalsa,
          sedeNome: stringaOFalsa,
          testoRecensione: stringaOFalsa,
          messaggioId: stringaOFalsa,
          // Il ticket collegato, da chiudere alla pubblicazione.
          ticketId: { bsonType: ["int", "null"] },
          // Esito della chiusura Freshdesk, con la sua coda di retry.
          freshdeskEsito: { enum: ["noniniziato", "ok", "inattesa", "fallito"] },
          freshdeskTentativi: { bsonType: "int", minimum: 0 },
          freshdeskProssimoTentativoIl: dataO,
          freshdeskErrore: stringaOFalsa,
          // Verifica foto: per ora sempre false e mai richiesta (nessun
          // rilevamento foto esiste), ma il campo c'è per quando arriverà.
          photoChecked: boolo,
          // Ciclo di pubblicazione/verifica.
          approvataIl: { bsonType: "date" },
          approvataDa: { bsonType: "int" },
          pubblicataIl: dataO,
          pubblicataDa: { bsonType: ["int", "null"] },
          metodoPubblicazione: stringaOFalsa, // "" | "manuale" | "api"
          promemoriaVerificaIl: dataO,
          verificataIl: dataO,
          verificataDa: { bsonType: ["int", "null"] },
          esitoVerifica: stringaOFalsa, // "" | "confermata" | "sparita"
          ripubblicazioni: { bsonType: "int", minimum: 0 },
          creataIl: { bsonType: "date" },
          aggiornataIl: { bsonType: "date" },
        },
      },
    },
    indici: [
      // La coda "da pubblicare": stato approvata, dalla più vecchia.
      { key: { stato: 1, approvataIl: 1 }, name: "i_pubblicazioni_coda" },
      // La tab "da ricontrollare": pubblicate, ordinate per promemoria.
      {
        key: { promemoriaVerificaIl: 1 },
        name: "i_pubblicazioni_promemoria",
        partialFilterExpression: { stato: "pubblicata" },
      },
      // La coda di retry Freshdesk.
      {
        key: { freshdeskProssimoTentativoIl: 1 },
        name: "i_pubblicazioni_retry",
        partialFilterExpression: { freshdeskEsito: "inattesa" },
      },
      { key: { origine: 1, stato: 1 }, name: "i_pubblicazioni_origine" },
      { key: { sedeChiave: 1, stato: 1 }, name: "i_pubblicazioni_sede" },
    ],
  },

  {
    nome: "impostazioni",
    validator: {
      $and: [
        { $expr: { $eq: ["$_id", "correnti"] } },
        // Nessuna chiave segreta può comparire nei valori. Un validator non può
        // fare sotto-query, quindi l'elenco è compilato qui da CATALOGO_IMPOSTAZIONI
        // e riallineato a ogni avvio.
        {
          $expr: {
            $eq: [{ $size: { $setIntersection: [{ $ifNull: ["$valori.chiave", []] }, SEGRETI] } }, 0],
          },
        },
        {
          $jsonSchema: {
            bsonType: "object",
            additionalProperties: false,
            required: ["_id", "valori", "etichette", "aggiornateIl"],
            properties: {
              _id: stringa,
              aggiornateIl: { bsonType: "date" },
              aggiornateDa: { bsonType: "int" },
              valori: {
                bsonType: "array",
                items: {
                  bsonType: "object",
                  additionalProperties: false,
                  required: ["chiave", "valore"],
                  properties: {
                    chiave: stringa,
                    valore: stringaOFalsa,
                    aggiornataIl: { bsonType: "date" },
                    aggiornataDa: { bsonType: "int" },
                  },
                },
              },
              etichette: {
                bsonType: "array",
                items: {
                  bsonType: "object",
                  additionalProperties: false,
                  required: ["id", "nome"],
                  properties: {
                    id: stringa,
                    nome: stringa,
                    oggettoContiene: stringaOFalsa,
                    mittenteContiene: stringaOFalsa,
                  },
                },
              },
            },
          },
        },
      ],
    },
    indici: [],
  },

  {
    nome: "impostazioni_catalogo",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        additionalProperties: false,
        required: ["_id", "etichetta", "segreto"],
        properties: {
          _id: stringa,
          etichetta: stringa,
          segreto: boolo,
          variabileEnv: stringaOFalsa,
        },
      },
    },
    indici: [],
  },

  {
    nome: "impostazioni_storico",
    validator: {
      $and: [
        // Il flag deve coincidere col catalogo compilato: non lo si dichiara a
        // piacere. È questa clausola a impedire di aggirare la prossima
        // passando segreto:false.
        { $expr: { $eq: ["$segreto", { $in: ["$chiave", SEGRETI] }] } },
        // Segreto => nessun valore, mai. Né hash, né lunghezza, né ultimo carattere.
        {
          $expr: {
            $or: [
              { $eq: ["$segreto", false] },
              {
                $and: [
                  { $eq: [{ $ifNull: ["$valorePrecedente", null] }, null] },
                  { $eq: [{ $ifNull: ["$valoreNuovo", null] }, null] },
                ],
              },
            ],
          },
        },
        {
          $jsonSchema: {
            bsonType: "object",
            additionalProperties: false,
            required: [
              "_id",
              "chiave",
              "segreto",
              "quando",
              "operatoreId",
              "azione",
              "presentePrima",
              "presenteDopo",
              "sigillo",
            ],
            properties: {
              _id: { bsonType: "objectId" },
              chiave: stringa,
              segreto: boolo,
              quando: { bsonType: "date" },
              operatoreId: { bsonType: "int" },
              azione: { enum: ["impostata", "modificata", "svuotata"] },
              valorePrecedente: stringaO,
              valoreNuovo: stringaO,
              presentePrima: boolo,
              presenteDopo: boolo,
              sigillo: sha1,
            },
          },
        },
      ],
    },
    indici: [
      { key: { chiave: 1, quando: -1, _id: -1 }, name: "i_imp_storico_chiave" },
      { key: { quando: -1, _id: -1 }, name: "i_imp_storico_quando" },
    ],
  },

  {
    nome: "traduzioni",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        additionalProperties: false,
        required: ["_id", "italiano", "creataIl", "usataIl", "usi"],
        properties: {
          // La forma della chiave È la protezione: impedisce che qualcuno cambi
          // il modo di calcolarla e faccia ripagare Azure per tutto lo storico.
          _id: { bsonType: "string", pattern: "^[0-9a-f]{20}$" },
          testoOriginale: stringaOFalsa,
          italiano: { bsonType: "string", minLength: 1 },
          linguaRilevata: stringaO,
          creataIl: { bsonType: "date" },
          usataIl: { bsonType: "date" },
          usi: { bsonType: "int", minimum: 0 },
        },
      },
    },
    indici: [
      { key: { linguaRilevata: 1 }, name: "i_traduzioni_lingua" },
      { key: { usataIl: 1 }, name: "i_traduzioni_uso" },
    ],
  },

  {
    nome: "travasi",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        additionalProperties: false,
        required: ["_id", "eseguitoIl", "righe"],
        properties: {
          _id: stringa,
          eseguitoIl: { bsonType: "date" },
          righe: { bsonType: "int", minimum: 0 },
          nota: stringaOFalsa,
        },
      },
    },
    indici: [],
  },

  {
    nome: "contatori",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        additionalProperties: false,
        required: ["_id", "valore"],
        properties: { _id: stringa, valore: { bsonType: "int", minimum: 0 } },
      },
    },
    indici: [],
  },

  {
    nome: "lucchetti",
    validator: {
      $jsonSchema: {
        bsonType: "object",
        additionalProperties: false,
        required: ["_id", "preso"],
        properties: {
          _id: stringa,
          preso: { bsonType: "date" },
          completato: dataO,
        },
      },
    },
    indici: [],
  },
];

// --------------------------------------------------------------------- viste

export const VISTE: { nome: string; viewOn: string; pipeline: Document[] }[] = [
  {
    nome: "vista_recensioni",
    viewOn: "recensioni",
    pipeline: [
      { $lookup: { from: "sedi", localField: "sede.chiave", foreignField: "_id", as: "_s" } },
      { $unwind: { path: "$_s", preserveNullAndEmptyArrays: true } },
      { $lookup: { from: "lingue", localField: "lingua", foreignField: "_id", as: "_l" } },
      { $unwind: { path: "$_l", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "esecuzioni",
          let: { k: "$_id" },
          as: "_auto",
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$recensioneChiave", "$$k"] },
                    { $eq: ["$annullata", false] },
                    { $eq: ["$modo", "reale"] },
                    { $eq: ["$esito", "ok"] },
                  ],
                },
              },
            },
            { $limit: 1 },
            { $project: { _id: 1 } },
          ],
        },
      },
      {
        $set: {
          // Il nome corrente della sede vince sul denormalizzato: rinominarla
          // si propaga senza riscrivere le recensioni.
          sede: { $ifNull: ["$_s.nome", "$sede.nome"] },
          tagFreshdesk: { $ifNull: ["$_s.tagFreshdesk", "$sede.tagFreshdesk"] },
          sedeChiave: "$sede.chiave",
          lingua: { $ifNull: ["$_l.nome", "non rilevata"] },
          linguaCodice: "$lingua",
          oreAllaRisposta: {
            $cond: [
              { $ne: ["$rispostaRilevataIl", null] },
              {
                $round: [
                  {
                    $divide: [
                      {
                        $dateDiff: {
                          startDate: "$ricevutaIl",
                          endDate: "$rispostaRilevataIl",
                          unit: "minute",
                        },
                      },
                      60,
                    ],
                  },
                  1,
                ],
              },
              null,
            ],
          },
          gestione: {
            $switch: {
              branches: [
                { case: { $gt: [{ $size: "$_auto" }, 0] }, then: "automatica" },
                { case: { $eq: ["$haRisposta", true] }, then: "a mano" },
              ],
              default: "da lavorare",
            },
          },
        },
      },
      { $unset: ["_s", "_l", "_auto"] },
    ],
  },
];

// ----------------------------------------------------------- applicazione

/**
 * Rende vero lo schema dichiarato. Idempotente: si può rieseguire a ogni avvio.
 *   - crea la collezione col validator se manca, altrimenti riallinea il
 *     validator con collMod (così il divieto sui segreti segue il catalogo)
 *   - crea gli indici (createIndexes è idempotente per nome)
 *   - crea o riallinea le viste
 */
export async function applicaSchema(d: Db): Promise<void> {
  const presenti = await d.listCollections({}, { nameOnly: false }).toArray();
  const perNome = new Map(presenti.map((c) => [c.name, c]));

  for (const def of COLLEZIONI) {
    const opzioni = {
      validator: def.validator,
      validationLevel: "strict" as const,
      validationAction: "error" as const,
    };
    const esistente = perNome.get(def.nome);
    if (!esistente) {
      await d.createCollection(def.nome, opzioni);
    } else {
      // Riallinea sempre: se qualcuno avesse messo validationAction:"warn" per
      // spegnere il controllo, questo lo riaccende.
      await d.command({ collMod: def.nome, ...opzioni });
    }
    if (def.indici.length > 0) {
      await d.collection(def.nome).createIndexes(def.indici);
    }
  }

  for (const v of VISTE) {
    const esistente = perNome.get(v.nome);
    if (!esistente) {
      await d.createCollection(v.nome, { viewOn: v.viewOn, pipeline: v.pipeline });
    } else {
      await d.command({ collMod: v.nome, viewOn: v.viewOn, pipeline: v.pipeline });
    }
  }
}

/** Elenco delle collezioni vere (non viste), per la verifica. */
export const NOMI_COLLEZIONI = COLLEZIONI.map((c) => c.nome);
