import Anthropic from "@anthropic-ai/sdk";

// Client Claude (Anthropic). La chiave sta SOLO nel .env (mai nel codice, mai
// con prefisso NEXT_PUBLIC_: resterebbe nel browser). Questo modulo è server-only.

if (typeof window !== "undefined") {
  throw new Error("src/server/ai/claude non è importabile dal browser: usa la chiave API.");
}

/**
 * Modello di default. Si può cambiare da .env con CLAUDE_MODEL senza toccare il
 * codice. Sulle nostre quantità (~200 risposte al mese, poche centinaia di
 * token l'una) la spesa è di pochi euro al mese: non conviene scendere di
 * modello per risparmiare.
 */
export const MODELLO_DEFAULT = "claude-opus-5";

export function modelloClaude(): string {
  return (process.env.CLAUDE_MODEL || "").trim() || MODELLO_DEFAULT;
}

export function isClaudeConfigured(): boolean {
  return Boolean((process.env.ANTHROPIC_API_KEY || "").trim());
}

let cliente: Anthropic | null = null;

/** Il client, creato una volta sola. Solleva se manca la chiave. */
export function claude(): Anthropic {
  if (!isClaudeConfigured()) {
    throw new Error("ANTHROPIC_API_KEY non configurata: aggiungila al .env (vedi .env.example).");
  }
  if (!cliente) cliente = new Anthropic();
  return cliente;
}

/** Prezzi per milione di token, per stimare la spesa (Claude Opus 5). */
const PREZZI: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

export type Consumo = {
  input: number;
  output: number;
  cacheLetta: number;
  cacheScritta: number;
  costo: number;
};

/**
 * Costo in dollari di una chiamata. La cache letta costa 1/10 dell'input, la
 * cache scritta 1,25×: è per questo che tenere stabile il contesto conviene.
 */
export function consumoDi(
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  },
  modello: string,
): Consumo {
  const p = PREZZI[modello] ?? PREZZI[MODELLO_DEFAULT];
  const cacheLetta = usage.cache_read_input_tokens ?? 0;
  const cacheScritta = usage.cache_creation_input_tokens ?? 0;
  const costo =
    (usage.input_tokens * p.input +
      cacheLetta * p.input * 0.1 +
      cacheScritta * p.input * 1.25 +
      usage.output_tokens * p.output) /
    1_000_000;
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheLetta,
    cacheScritta,
    costo,
  };
}
