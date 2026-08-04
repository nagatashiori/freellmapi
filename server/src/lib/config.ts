const DEFAULT_RPM = 120;
// Upper bound on trusted proxy hops: a value above this is almost certainly a
// misconfiguration, and rejecting it keeps Express's trust-proxy arithmetic sane.
const MAX_TRUST_PROXY_HOPS = 64;

function parseRateLimitRpm(): number {
  const raw = process.env.PROXY_RATE_LIMIT_RPM;
  if (raw === undefined || raw.trim() === '') return DEFAULT_RPM;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RPM;
  return Math.floor(n);
}

// How many reverse-proxy hops to trust for caller identity. 0 (default) means
// X-Forwarded-For is ignored and req.ip is the socket peer. A public nginx
// deployment in front of this server sets this to 1.
function parseTrustProxyHops(): number {
  const raw = process.env.TRUST_PROXY_HOPS;
  if (raw === undefined || raw.trim() === '') return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > MAX_TRUST_PROXY_HOPS) return 0;
  return n;
}

export interface Config {
  port: number | string;
  host: string;
  dbPath: string | null;
  dashboardOrigins: string[];
  clientDist: string | null;
  proxyRateLimitRpm: number;
  trustProxyHops: number;
  nodeEnv: string;
  serveStaticAssets: boolean;
}

export function loadConfig(): Config {
  return {
    port: process.env.PORT ?? 3001,
    // Dual-stack ('::') by default so the dashboard is reachable over both IPv4
    // and IPv6 (e.g. IPv6-enabled Docker networks — #180). Hosts with IPv6
    // disabled fall back to IPv4-only below; HOST overrides the default outright.
    host: process.env.HOST ?? '::',
    dbPath: process.env.FREEAPI_DB_PATH?.trim() || null,
    dashboardOrigins: (process.env.DASHBOARD_ORIGINS ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    clientDist: process.env.CLIENT_DIST ?? null,
    proxyRateLimitRpm: parseRateLimitRpm(),
    trustProxyHops: parseTrustProxyHops(),
    nodeEnv: process.env.NODE_ENV ?? 'development',
    serveStaticAssets: true,
  };
}
