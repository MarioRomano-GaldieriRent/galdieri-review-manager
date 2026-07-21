/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Fissa la root del progetto: evita che Next scelga un lockfile vagante
  // nella home dell'utente come radice del workspace.
  outputFileTracingRoot: import.meta.dirname,
};

export default nextConfig;
