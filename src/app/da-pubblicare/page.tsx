import { redirect } from "next/navigation";

// La coda "Da pubblicare" ora vive nella home, come tab della pipeline. Questa
// pagina resta solo per non rompere vecchi link e bookmark: gira i parametri
// sul passo giusto della home e reindirizza.

export const dynamic = "force-dynamic";

export default async function DaPubblicareRedirect({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; sede?: string }>;
}) {
  const sp = await searchParams;
  if (sp.tab === "ricontrollo") redirect("/?step=ricontrollo");
  const q = new URLSearchParams({ step: "pubblicare" });
  if (sp.sede) q.set("sede", sp.sede);
  redirect(`/?${q}`);
}
