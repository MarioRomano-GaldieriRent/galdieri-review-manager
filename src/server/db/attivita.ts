import { coll } from "./connessione";

// Registro attività: chi ha fatto cosa, quando, su quale oggetto. È l'AuditLog
// dello spec. Ogni azione che modifica qualcosa dovrebbe passare di qui.
//
// L'operatore di default è 1 (Sistema): finché non c'è un login, ogni azione
// dell'interfaccia è attribuita a lui. Il campo resta, così il giorno che
// arriverà l'autenticazione basterà passare l'id vero.
//
// Non blocca mai: un audit mancato non deve far fallire l'azione che descrive.

export const OPERATORE_SISTEMA = 1;

export async function registraAttivita(
  azione: string,
  opts: {
    operatoreId?: number;
    oggettoTipo?: string;
    oggettoId?: string;
    dettaglio?: string;
  } = {},
): Promise<void> {
  try {
    await (
      await coll("registro_attivita")
    ).insertOne({
      quando: new Date(),
      operatoreId: opts.operatoreId ?? OPERATORE_SISTEMA,
      azione,
      oggettoTipo: opts.oggettoTipo ?? null,
      oggettoId: opts.oggettoId ?? null,
      dettaglio: opts.dettaglio ?? "",
    });
  } catch (e) {
    console.error("[attivita] registrazione non riuscita:", e);
  }
}
