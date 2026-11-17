const net = require('node:net');
const dns = require('node:dns').promises;
function isHostSafe(host) {
  if (!net.isIP(host)) return false;
  const ip = host.toLowerCase();
  if (net.isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127));
  }
  const normalized = new URL('http://[' + ip + ']/').hostname.slice(1, -1);
  if (normalized.startsWith('::ffff:')) {
    const words = normalized.slice(7).split(':').map(s => parseInt(s, 16));
    return words.length === 2 && isHostSafe([words[0] >> 8, words[0] & 255, words[1] >> 8, words[1] & 255].join('.'));
  }
  return /^[23]/.test(normalized) && !normalized.startsWith('2002:') &&
    !normalized.startsWith('2001:db8:') && !normalized.startsWith('2001::');
}
function parseHostPort(address) {
  if (typeof address !== 'string') throw new Error('Invalid destination');
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(address);
  if (!match) throw new Error('Invalid destination');
  const port = Number(match[3]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  return { host: match[1] || match[2], port };
}
async function resolveTarget(address, allowPrivate = false) {
  const { host, port } = parseHostPort(address);
  const addresses = await dns.lookup(host, { all: true });
  if (!addresses.length || (!allowPrivate && addresses.some(a => !isHostSafe(a.address)))) throw new Error('Private destination blocked');
  return { host: addresses[0].address, port, family: addresses[0].family };
}
module.exports = { isHostSafe, parseHostPort, resolveTarget };
