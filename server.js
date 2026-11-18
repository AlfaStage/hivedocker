const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const net = require('node:net');
const WebSocket = require('ws');
const { resolveTarget } = require('./hostValidator');

function createNode(options = {}) {
  const configFile = options.configFile || process.env.CONFIG_FILE || path.join(__dirname, 'data', 'config.json');
  let config = {};
  try { config = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  config.panelToken ||= process.env.PANEL_TOKEN || crypto.randomBytes(32).toString('hex');
  config.installationId ||= crypto.randomUUID();
  const webBase = options.webBase || process.env.WEB_BASE || 'https://hivenode.alfastage.com.br';
  const brokerBase = options.brokerBase || process.env.BROKER_URL || 'wss://api.hivenode.alfastage.com.br';
  const visibility = options.visibility || process.env.NODE_VISIBILITY || 'PUBLIC';
  if (!['PUBLIC', 'PRIVATE'].includes(visibility)) throw new Error('Invalid NODE_VISIBILITY');
  const allowPrivate = process.env.APP_ENV === 'test' && process.env.ALLOW_PRIVATE_TARGETS === 'true';
  const save = () => {
    fs.mkdirSync(path.dirname(configFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${configFile}.tmp`, JSON.stringify(config), { mode: 0o600 });
    fs.renameSync(`${configFile}.tmp`, configFile);
  };
  save();
  let session = null;
  let reconnectTimer = null;
  let attempts = 0;
  let stopped = true;
  let pollBusy = false;
  let authGeneration = 0;
  let pending = null;
  let autoTimer = null;
  const resolveDestination = options.resolveTarget || resolveTarget;
  const logs = [];
  function log(message) { logs.unshift({ time: new Date().toISOString(), message }); logs.splice(50); }
  function send(s, payload) {
    if (s.ws.readyState === WebSocket.OPEN) s.ws.send(typeof payload === 'object' && !Buffer.isBuffer(payload) ? JSON.stringify(payload) : payload);
  }
  function status() { return { nodeId: config.nodeId || null, nodeName: config.nodeName || 'HiveDocker',
    isConnected: session?.ws.readyState === WebSocket.OPEN, uptime: session?.started ? Math.floor((Date.now() - session.started) / 1000) : 0,
    retryCount: attempts, logs, pendingCode: pending?.userCode || null,
    verificationUri: pending?.verificationUri || null }; }
  function start() {
    if (session || !config.nodeId || !config.tunnelSecret) return;
    stopped = false;
    clearTimeout(reconnectTimer);
    const timestamp = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', config.tunnelSecret).update(`${config.nodeId}:${timestamp}`).digest('hex');
    const ws = new WebSocket(`${brokerBase}/tunnel?nodeId=${config.nodeId}&ts=${timestamp}&sig=${sig}`, { maxPayload: 1048576, handshakeTimeout: 10000 });
    const s = { ws, sockets: new Map(), started: null, telemetry: null, pending: new Map() };
    session = s;
    ws.on('open', () => {
      attempts = 0; s.started = Date.now(); log('Túnel conectado');
      s.telemetry = setInterval(() => send(s, { type: 'TELEMETRY', network: 'DATACENTER', uptime: Math.floor((Date.now() - s.started) / 1000) }), 30000);
    });
    ws.on('message', async (data, binary) => {
      if (binary) {
        const length = data[0];
        if (!length || data.length < 1 + length) return;
        const socket = s.sockets.get(data.subarray(1, 1 + length).toString());
        if (socket) {
          if (socket.writableLength > 1048576) { socket.destroy(); return; }
          socket.write(data.subarray(1 + length));
        }
        return;
      }
      let message;
      try { message = JSON.parse(data.toString()); } catch { return; }
      const { type, connId, host } = message;
      if (type === 'NODE_RENAMED') { config.nodeName = String(message.newName).slice(0, 100); save(); return; }
      if (type === 'CLOSE') { const pending = s.pending.get(connId); if (pending) pending.cancelled = true; s.sockets.get(connId)?.destroy(); return; }
      if (type !== 'DIAL' || typeof connId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(connId) || s.sockets.has(connId) || s.pending.has(connId)) return;
      if (s.sockets.size + s.pending.size >= 64) { send(s, { type: 'DIAL_ERR', connId }); return; }
      const pending = { cancelled: false };
      s.pending.set(connId, pending);
      try {
        const destination = await resolveDestination(host, allowPrivate);
        if (pending.cancelled || session !== s || ws.readyState !== WebSocket.OPEN) return;
        const socket = net.createConnection(destination);
        s.sockets.set(connId, socket);
        socket.setTimeout(120000, () => socket.destroy());
        socket.on('connect', () => send(s, { type: 'DIAL_OK', connId }));
        socket.on('data', buffer => {
          if (ws.bufferedAmount > 1048576) { socket.destroy(); return; }
          const id = Buffer.from(connId);
          send(s, Buffer.concat([Buffer.from([id.length]), id, buffer]));
        });
        socket.on('error', () => send(s, { type: 'DIAL_ERR', connId }));
        socket.on('close', () => { s.sockets.delete(connId); send(s, { type: 'CLOSE', connId }); });
      } catch { send(s, { type: 'DIAL_ERR', connId }); }
      finally { if (s.pending.get(connId) === pending) s.pending.delete(connId); }
    });
    ws.on('error', () => log('Falha de conexão com o broker'));
    ws.on('close', (_code, reason) => {
      clearInterval(s.telemetry);
      for (const socket of s.sockets.values()) socket.destroy();
      if (session !== s) return;
      session = null;
      if (reason.toString() === 'KICKED') { stopped = true; log('Acesso revogado pelo painel'); }
      if (!stopped) {
        const delay = Math.min(30000, 1000 * 2 ** attempts++) + Math.floor(Math.random() * 500);
        reconnectTimer = setTimeout(start, delay);
      }
    });
  }
  function stop() { stopped = true; clearTimeout(reconnectTimer); const previous = session; session = null; if (previous) { previous.ws.terminate(); for (const socket of previous.sockets.values()) socket.destroy(); } }
  async function api(route, body, token) {
    const response = await fetch(`${webBase}/api${route}`, { method: 'POST', headers: {
      'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error || 'API unavailable');
    return result.data;
  }
  // Troca o deviceCode aprovado por credenciais definitivas do no.
  async function finishLink(deviceCode, generation) {
    const poll = await api('/auth/device-code/poll', { deviceCode });
    if (poll.status !== 'success') return false;
    const login = await api('/auth/qr-login', { linkToken: poll.token });
    const registered = await api('/nodes', { deviceName: 'HiveDocker', visibility, installationId: config.installationId }, login.token);
    if (generation !== authGeneration) throw new Error('Vínculo cancelado');
    if (!registered.tunnelSecret) throw new Error('Missing device credential');
    config.nodeId = registered.node.id; config.tunnelSecret = registered.tunnelSecret; save();
    pending = null;
    start();
    return true;
  }
  // Pede um codigo de vinculo sozinho e repete no log ate alguem aprovar.
  // Assim o codigo aparece em `docker logs` sem precisar abrir o painel local.
  async function autoLink() {
    clearTimeout(autoTimer);
    if (config.nodeId || process.env.AUTO_LINK === 'false') return;
    const generation = authGeneration;
    const retry = seconds => { autoTimer = setTimeout(autoLink, seconds * 1000); };
    try {
      if (!pending || pending.expiresAt <= Date.now()) {
        const created = await api('/auth/device-code/generate', { type: visibility === 'PUBLIC' ? 'miner' : 'proxy' });
        pending = { ...created, expiresAt: Date.now() + (created.expiresIn || 300) * 1000 };
        const message = `CODIGO DE VINCULO: ${pending.userCode} — aprove em ${webBase}/dashboard/admin/device-approve (vale ${Math.round((created.expiresIn || 300) / 60)} min)`;
        log(message);
        console.log(message);
      }
      if (await finishLink(pending.deviceCode, generation)) {
        log('Aparelho vinculado');
        console.log('Aparelho vinculado com sucesso.');
        return;
      }
      retry(5);
    } catch (error) {
      if (error.message === 'Vínculo cancelado') return;
      pending = null;
      log(`Falha ao pedir codigo de vinculo: ${error.message}`);
      console.log(`Falha ao pedir codigo de vinculo: ${error.message}. Nova tentativa em 30s.`);
      retry(30);
    }
  }
  function stopAutoLink() { clearTimeout(autoTimer); pending = null; }
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.use(express.static(path.join(__dirname, 'public')));
  app.use('/api', (req, res, next) => {
    const supplied = req.headers.authorization?.replace(/^Bearer /, '') || '';
    if (Buffer.byteLength(supplied) !== Buffer.byteLength(config.panelToken) || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(config.panelToken))) return res.status(401).json({ error: 'Token do painel inválido' });
    next();
  });
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/api/status', (_req, res) => res.json(status()));
  app.post('/api/tunnel/start', (_req, res) => { start(); res.json({ success: true }); });
  app.post('/api/tunnel/stop', (_req, res) => { stop(); res.json({ success: true }); });
  app.post('/api/logout', (_req, res) => { authGeneration++; stop(); stopAutoLink(); delete config.nodeId; delete config.tunnelSecret; delete config.token; delete config.linkToken; save(); res.json({ success: true }); autoLink(); });
  app.get('/api/link-code', (_req, res) => res.json({ data: {
    linked: Boolean(config.nodeId), userCode: pending?.userCode || null,
    approveUrl: `${webBase}/dashboard/admin/device-approve`,
    expiresInSeconds: pending ? Math.max(0, Math.round((pending.expiresAt - Date.now()) / 1000)) : 0 } }));
  app.post('/api/auth/start', async (_req, res) => {
    try { res.json({ success: true, data: await api('/auth/device-code/generate', { type: visibility === 'PUBLIC' ? 'miner' : 'proxy' }) }); }
    catch (error) { res.status(502).json({ error: error.message }); }
  });
  app.post('/api/auth/poll', async (req, res) => {
    if (pollBusy) return res.json({ data: { status: 'pending' } });
    pollBusy = true;
    const generation = authGeneration;
    try {
      if (config.nodeId) return res.json({ data: { status: 'success' } });
      if (!await finishLink(req.body.deviceCode, generation)) return res.json({ data: { status: 'pending' } });
      clearTimeout(autoTimer);
      res.json({ data: { status: 'success' } });
    } catch (error) { res.status(502).json({ error: error.message }); }
    finally { pollBusy = false; }
  });
  return { app, start, stop, status, autoLink, stopAutoLink, panelToken: config.panelToken };
}
if (require.main === module) {
  const node = createNode();
  const server = node.app.listen(Number(process.env.PORT || 8080), process.env.HOST || '127.0.0.1', () => {
    console.log('HiveDocker ready. Panel token is stored in data/config.json (or PANEL_TOKEN).');
    node.start();
    node.autoLink();
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { node.stop(); node.stopAutoLink(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); });
}
module.exports = { createNode };
