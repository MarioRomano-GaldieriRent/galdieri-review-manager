/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Fissa la root del progetto: evita che Next scelga un lockfile vagante
  // nella home dell'utente come radice del workspace.
  outputFileTracingRoot: import.meta.dirname,
  // Il driver mongodb resta un modulo server esterno: webpack non deve
  // impacchettarlo, altrimenti prova a risolvere le sue dipendenze native
  // opzionali (snappy, socks, client-encryption, kerberos…) e i builtin
  // net/crypto, e la compilazione rompe. node:sqlite è un builtin: già esterno.
  serverExternalPackages: ["mongodb"],
  webpack: (config, { isServer }) => {
    if (isServer) {
      // Lascia che sia Node a richiederlo a runtime da node_modules, invece di
      // impacchettarlo. Vale sia per il bundle nodejs sia per quello edge di
      // instrumentation.ts, dove i socket TCP non esistono nemmeno.
      config.externals = [...(config.externals ?? []), "mongodb"];
    }
    return config;
  },
};

export default nextConfig;
