import { esportaSediCsv, leggiSedi } from "@/server/db/sedi";
import { operatoreCorrente } from "@/server/auth/sessione";

// Scarica le sedi in CSV, per compilare i link tutti insieme e reimportarli.
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  // Il route handler è un endpoint a sé: il middleware controlla solo la
  // presenza del cookie, quindi la validazione vera della sessione va fatta qui.
  if (!(await operatoreCorrente())) {
    return new Response("Non autorizzato", { status: 401 });
  }
  const csv = esportaSediCsv(await leggiSedi());
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="sedi-galdieri.csv"',
    },
  });
}
