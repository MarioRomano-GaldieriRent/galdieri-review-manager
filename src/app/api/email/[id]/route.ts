import { NextResponse } from "next/server";
import { getMessage, isGraphConfigured } from "@/server/graph/client";
import { activeMailbox } from "@/server/settings";

// Contenuto di una singola email, per il pop-up "Vedi mail" della home: si
// carica solo quando serve (al click), senza cambiare pagina. Il corpo torna
// già impacchettato come documento pronto per un <iframe sandbox>.

export const dynamic = "force-dynamic";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildSrcDoc(content: string, isHtml: boolean): string {
  const style = `
    <style>
      body { margin:0; padding:16px; font-family:"Segoe UI",system-ui,sans-serif;
             font-size:14px; line-height:1.55; color:#202124; background:#fff; }
      img, table { max-width:100%; height:auto; }
      pre { white-space:pre-wrap; word-wrap:break-word; font-family:inherit; }
      a { color:#1a73e8; }
    </style>`;
  const body = isHtml ? content : `<pre>${escapeHtml(content)}</pre>`;
  return `<!doctype html><html><head><meta charset="utf-8">${style}</head><body>${body}</body></html>`;
}

const fmt = new Intl.DateTimeFormat("it-IT", { dateStyle: "medium", timeStyle: "short" });

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await isGraphConfigured()) || !id) {
    return NextResponse.json({ errore: "Configurazione o id mancante." }, { status: 400 });
  }
  try {
    const mailbox = await activeMailbox();
    const m = await getMessage(id, mailbox);
    return NextResponse.json({
      subject: m.subject || "(senza oggetto)",
      from: m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress,
      data: fmt.format(new Date(m.receivedDateTime)),
      srcDoc: buildSrcDoc(m.bodyContent, m.bodyIsHtml),
    });
  } catch (e) {
    return NextResponse.json(
      { errore: e instanceof Error ? e.message : "Errore sconosciuto" },
      { status: 500 },
    );
  }
}
