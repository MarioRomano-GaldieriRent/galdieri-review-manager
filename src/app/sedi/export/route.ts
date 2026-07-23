import { esportaSediCsv, leggiSedi } from "@/server/db/sedi";

// Scarica le sedi in CSV, per compilare i link tutti insieme e reimportarli.
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const csv = esportaSediCsv(await leggiSedi());
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="sedi-galdieri.csv"',
    },
  });
}
