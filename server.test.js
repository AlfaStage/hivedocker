const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { once } = require('node:events');
const { WebSocketServer } = require('ws');
const { createNode } = require('./server');
const { isHostSafe, parseHostPort, resolveTarget } = require('./hostValidator');
async function fixture(t, config = {}, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hivedocker-test-'));
  const file = path.join(dir, 'config.json');
  await fs.writeFile(file, JSON.stringify(config));
  const node = createNode({ configFile: file, ...options });
  const server = node.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { node.stop(); await new Promise(resolve => server.close(resolve)); await fs.rm(dir, { recursive: true }); });
  return { node, url: 'http://127.0.0.1:' + server.address().port, file };
}
test('bootstrap persists identity and all panel APIs require auth', async t => {
  const { node, url, file } = await fixture(t);
  const config = JSON.parse(await fs.readFile(file));
  assert.ok(config.installationId); assert.equal(config.panelToken, node.panelToken);
  assert.equal((await fetch(url + '/health')).status, 200);
  assert.equal((await fetch(url + '/api/status')).status, 401);
  const response = await fetch(url + '/api/status', { headers: { Authorization: 'Bearer ' + node.panelToken } });
  assert.equal(response.status, 200); assert.equal((await response.json()).nodeId, null);
});
test('private targets are rejected including expanded and mapped IPv6', async () => {
  for (const ip of ['127.0.0.1','10.0.0.1','100.64.0.1','0:0:0:0:0:0:0:1','0:0:0:0:0:ffff:7f00:1','fd00::1','fe80::1']) assert.equal(isHostSafe(ip), false, ip);
  assert.equal(isHostSafe('8.8.8.8'), true); assert.equal(isHostSafe('2606:4700:4700::1111'), true);
  assert.deepEqual(parseHostPort('[2606:4700:4700::1111]:443'), { host: '2606:4700:4700::1111', port: 443 });
  assert.throws(() => parseHostPort('example.org:0'));
  await assert.rejects(resolveTarget('localhost:80'));
});
test('pause followed immediately by start creates a fresh session', async t => {
  const broker = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(broker, 'listening');
  t.after(() => { for (const client of broker.clients) client.terminate(); broker.close(); });
  const { node } = await fixture(t, { nodeId: 'test-device', tunnelSecret: 'test-secret' }, { brokerBase: 'ws://127.0.0.1:' + broker.address().port });
  let connected = once(broker, 'connection'); node.start(); await connected;
  connected = once(broker, 'connection'); node.stop(); node.start(); await connected;
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(node.status().isConnected, true);
});
test('CLOSE cancels a pending DNS dial and prevents opening TCP afterwards', async t => {
  const target = net.createServer(socket => { socket.destroy(); }); target.listen(0, '127.0.0.1'); await once(target, 'listening');
  t.after(() => target.close()); let tcpCount = 0; target.on('connection', () => tcpCount++);
  const broker = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(broker, 'listening');
  t.after(() => { for (const client of broker.clients) client.terminate(); broker.close(); });
  let resolve; let reached; const entered = new Promise(r => { reached = r; });
  const { node } = await fixture(t, { nodeId: 'test-device', tunnelSecret: 'test-secret' }, { brokerBase: 'ws://127.0.0.1:' + broker.address().port, resolveTarget: () => { reached(); return new Promise(r => { resolve = r; }); } });
  const connected = once(broker, 'connection'); node.start(); const [peer] = await connected;
  peer.send(JSON.stringify({ type: 'DIAL', connId: 'test', host: 'example.org:443' })); await entered;
  peer.send(JSON.stringify({ type: 'CLOSE', connId: 'test' })); await new Promise(r => setTimeout(r, 30));
  resolve({ host: '127.0.0.1', port: target.address().port }); await new Promise(r => setTimeout(r, 60));
  assert.equal(tcpCount, 0);
});
