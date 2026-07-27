import { randomBytes } from "node:crypto";
import { creaUtente, type Ruolo } from "@/server/auth/utenti";

// Crea un utente di login da riga di comando. È il modo per fare il primo admin
// (quando non esiste ancora nessuno che possa aprire la gestione utenti) e per
// aggiungerne altri senza interfaccia.
//
//   npm run crea-utente -- --chiave mario --nome "Mario Romano" --ruolo admin
//
// La password si può passare con --password, ma è più sicuro ometterla: lo
// script ne genera una robusta e la stampa una volta sola. Al primo accesso
// l'utente attiva il TOTP e (se vuole) cambia la password.

function arg(nome: string): string | undefined {
  const p = `--${nome}`;
  const i = process.argv.indexOf(p);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) {
    return process.argv[i + 1];
  }
  const eq = process.argv.find((a) => a.startsWith(`${p}=`));
  return eq ? eq.slice(p.length + 1) : undefined;
}

/** Password casuale robusta ma digitabile (~18 caratteri url-safe). */
function passwordCasuale(): string {
  return randomBytes(14).toString("base64url");
}

(async () => {
  const chiave = arg("chiave") ?? process.env.UTENTE_CHIAVE;
  const nome = arg("nome") ?? process.env.UTENTE_NOME ?? chiave ?? "";
  const email = arg("email") ?? process.env.UTENTE_EMAIL;
  const ruoloIn = (arg("ruolo") ?? process.env.UTENTE_RUOLO ?? "operatore").toLowerCase();
  const ruolo: Ruolo = ruoloIn === "admin" ? "admin" : "operatore";

  let password = arg("password") ?? process.env.UTENTE_PASSWORD;
  const generata = !password;
  if (!password) password = passwordCasuale();

  if (!chiave) {
    console.error(
      'Uso: npm run crea-utente -- --chiave mario --nome "Mario Romano" --ruolo admin [--email x@y] [--password ...]',
    );
    process.exit(1);
  }

  try {
    const id = await creaUtente({ chiave, nome, email, ruolo, password });
    console.log("");
    console.log(`✓ Utente creato — id ${id}`);
    console.log(`  username : ${chiave}`);
    console.log(`  ruolo    : ${ruolo}`);
    if (generata) console.log(`  password : ${password}   (temporanea, mostrata solo ora)`);
    console.log("  Al primo accesso ti chiederà di attivare il TOTP inquadrando un QR.");
    console.log("");
    process.exit(0);
  } catch (e) {
    console.error("Errore:", e instanceof Error ? e.message : e);
    process.exit(1);
  }
})();
