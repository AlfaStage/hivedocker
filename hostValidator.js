const PRIVATE_RANGES = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^::1$/];

function isHostSafe(host, allowPrivate = false) {
  if (!host || host.length > 253) return false;
  if (/\s|[<>"'`]/.test(host)) return false; // sem meta chars
  if (host.startsWith("/") || host.startsWith("\\") || host.includes("..")) return false;
  if (host === "localhost") return allowPrivate;
  if (!allowPrivate) {
    return !PRIVATE_RANGES.some(rx => rx.test(host));
  }
  return true;
}

function parseHostPort(addr, defaultPort = 443) {
  // addr = "host:port" ou "host"
  const parts = addr.split(":");
  const host = parts[0];
  const port = parts.length > 1 ? parseInt(parts[1], 10) : defaultPort;
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    return { host, port: defaultPort };
  }
  return { host, port };
}

module.exports = { isHostSafe, parseHostPort };
