import { NextResponse, type NextRequest } from "next/server";
import { COOKIE_SESSIONE } from "@/server/auth/nomeCookie";

// Middleware (runtime edge): leggero per forza: qui non c'è accesso al database,
// quindi NON valida la sessione. Fa due cose sole:
//   1. segna il percorso in un header, così il layout sa se è la pagina di login
//   2. se manca proprio il cookie di sessione, rimanda al login senza nemmeno
//      rendere la pagina protetta.
// La validazione vera (sessione esistente, non scaduta, operatore attivo) resta
// nel layout con operatoreCorrente(): un cookie presente ma fasullo passa di qui
// ma viene fermato lì.

const PUBBLICHE = ["/login"];

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  const intestazioni = new Headers(req.headers);
  intestazioni.set("x-pathname", pathname);

  const suPubblica = PUBBLICHE.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  const haCookie = Boolean(req.cookies.get(COOKIE_SESSIONE)?.value);

  if (!suPubblica && !haCookie) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return NextResponse.next({ request: { headers: intestazioni } });
}

export const config = {
  // Tutto tranne asset e risorse interne di Next.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
