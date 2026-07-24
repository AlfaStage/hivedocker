const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const WebSocket = require('ws');
const CryptoJS = require('crypto-js');
const net = require('node:net');
const { parseHostPort, isHostSafe } = require('./hostValidator');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const CONFIG_FILE = path.join(__dirname, 'config.json');

let config = { serverIp: 'api.hivenode.alfastage.com.br', nodeId: null, linkToken: null, tunnelSecret: null };
try {
  if (fs.existsSync(CONFIG_FILE)) {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  }
} catch (e) { console.error('Error reading config', e); }

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

const crypto = require('node:crypto');

function ensurePanelToken() {
  if (!config.panelToken) {
    config.panelToken = crypto.randomBytes(24).toString('hex');
    saveConfig();
    addLog(`🔑 Novo token de painel gerado: ${config.panelToken.slice(0, 8)}...`);
  }
}
ensurePanelToken();

function requireToken(req, res, next) {
  if (process.env.HIVEDOCKER_PUBLIC === 'true') return next();
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token !== config.panelToken) {
    return res.status(401).json({ error: 'Acesso não autorizado' });
  }
  next();
}

app.use('/api/tunnel', requireToken);
app.use('/api/logout', requireToken);
app.use('/api/auth', requireToken);

let ws = null;
let isConnected = false;
const logs = [];
let tunnelStartTime = null;
let retryCount = 0;
let reconnectTimer = null;
let intentionalStop = false;
let telemetryInterval = null;

function addLog(msg) {
  const time = new Date().toLocaleTimeString();
  const logStr = `[${time}] ${msg}`;
  logs.unshift(logStr);
  if (logs.length > 100) logs.pop();
  console.log(logStr);
  
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "LOG", payload: msg }));
  }
  
  if (typeof broadcastUpdate === 'function') {
    broadcastUpdate();
  }
}

function scheduleReconnect() {
  if (intentionalStop) return;
  
  const baseDelay = Math.min(1000 * (2 ** retryCount), 30000);
  const jitter = baseDelay * 0.2 * (Math.random() - 0.5);
  const delay = Math.floor(baseDelay + jitter);
  
  addLog(`⏳ Reconnect em ${Math.round(delay/1000)}s...`);
  reconnectTimer = setTimeout(() => {
    retryCount += 1;
    startTunnel();
  }, delay);
}

function startTunnel() {
  if (!config.nodeId) {
    addLog("Erro: Aparelho não vinculado");
    return;
  }
  intentionalStop = false;
  retryCount = 0;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  
  if (ws) {
    ws.close();
  }
  if (typeof broadcastUpdate === 'function') broadcastUpdate();

  const hmacSig = CryptoJS.HmacSHA256(config.nodeId, config.tunnelSecret).toString(CryptoJS.enc.Hex);
  const wsUrl = `wss://${config.serverIp}/tunnel?nodeId=${config.nodeId}&sig=${hmacSig}`;

  addLog("Conectando ao Broker...");
  ws = new WebSocket(wsUrl, {
    pingInterval: 30000,
    pingTimeout: 10000,
  });
  
  const activeSockets = {};

  ws.on('open', () => {
    isConnected = true;
    tunnelStartTime = Date.now();
    retryCount = 0;
    addLog("✅ Túnel TCP Reverso Conectado!");
    
    telemetryInterval = setInterval(() => {
      if (!ws || ws.readyState !== 1) return;
      const uptime = tunnelStartTime ? Math.floor((Date.now() - tunnelStartTime) / 1000) : 0;
      ws.send(JSON.stringify({
        type: "TELEMETRY",
        network: "DATACENTER",
        uptime: uptime
      }));
    }, 30000);
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      // Handle TCP Traffic
      if (data.length < 1) return;
      const idLen = data[0];
      if (data.length < 1 + idLen) return;
      
      const connIdBytes = data.slice(1, 1 + idLen);
      let connId = "";
      for (let i = 0; i < connIdBytes.length; i++) connId += String.fromCharCode(connIdBytes[i]);
      const payload = data.slice(1 + idLen);
      
      if (activeSockets[connId]) {
        activeSockets[connId].write(payload);
      }
      return;
    }

    // JSON Control
    try {
      const msg = JSON.parse(data.toString());
      const { connId, type, host } = msg;

      if (type === "NODE_RENAMED" && msg.newName) {
        config.nodeName = msg.newName;
        saveConfig();
        addLog(`✏️ Aparelho renomeado pelo painel: ${msg.newName}`);
        return;
      }

      if (type === "DIAL") {
        addLog(`[${connId}] Requisição TCP -> ${host}`);
        const { host: targetHost, port: targetPort } = parseHostPort(host, 443);
        
        if (!isHostSafe(targetHost)) {
          addLog(`❌ [${connId}] Host bloqueado: ${targetHost}`);
          ws.send(JSON.stringify({ connId, type: "DIAL_ERR" }));
          return;
        }
        
        const client = new net.Socket();
        
        client.connect(targetPort, targetHost, () => {
          ws.send(JSON.stringify({ connId, type: "DIAL_OK" }));
        });

        client.on('data', (buffer) => {
          const idBytes = Buffer.from(connId, 'utf-8');
          const outBuffer = Buffer.alloc(1 + idBytes.length + buffer.length);
          outBuffer[0] = idBytes.length;
          idBytes.copy(outBuffer, 1);
          buffer.copy(outBuffer, 1 + idBytes.length);
          ws.send(outBuffer);
        });

        client.on('error', (err) => {
          addLog(`❌ [${connId}] Erro TCP: ${err.message}`);
          ws.send(JSON.stringify({ connId, type: "DIAL_ERR" }));
        });

        client.on('close', () => {
          ws.send(JSON.stringify({ connId, type: "CLOSE" }));
          delete activeSockets[connId];
        });

        activeSockets[connId] = client;
      } else if (type === "CLOSE") {
        if (activeSockets[connId]) {
          activeSockets[connId].destroy();
          delete activeSockets[connId];
        }
      }
    } catch (e) {
      addLog(`Erro pacotes JSON: ${e.message}`);
    }
  });

  ws.on('close', (_code, reason) => {
    if (telemetryInterval) clearInterval(telemetryInterval);
    isConnected = false;
    tunnelStartTime = null;
    Object.values(activeSockets).forEach(s => { s.destroy(); });
    ws = null;
    
    const reasonStr = reason ? reason.toString('utf8') : '';
    
    if (reasonStr === 'KICKED') {
      addLog('🔨 Este nó foi removido pelo painel. Limpando credenciais...');
      config.nodeId = null;
      config.token = null;
      config.linkToken = null;
      saveConfig();
      return;
    }
    
    addLog('🛑 Túnel Desconectado.');
    scheduleReconnect();
  });

  ws.on('error', (e) => {
    addLog(`❌ Erro WebSocket: ${e.message}`);
  });
}

function stopTunnel() {
  intentionalStop = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (telemetryInterval) clearInterval(telemetryInterval);
  if (ws) {
    ws.close();
    ws = null;
  }
  if (typeof broadcastUpdate === 'function') broadcastUpdate();
}

// API Routes
app.get('/api/status', (_req, res) => {
  res.json({
    nodeId: config.nodeId,
    nodeName: config.nodeName,
    isConnected,
    uptime: tunnelStartTime ? Math.floor((Date.now() - tunnelStartTime) / 1000) : 0,
    logs: logs.slice(0, 20)
  });
});

app.post('/api/tunnel/start', (_req, res) => {
  startTunnel();
  res.json({ success: true });
});

app.post('/api/tunnel/stop', (_req, res) => {
  stopTunnel();
  res.json({ success: true });
});

// A simple local device-code flow
app.post('/api/auth/start', async (_req, res) => {
  try {
    const response = await fetch(`https://${config.serverIp}/api/auth/device-code/generate`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({type: 'miner'})
    });
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

app.post('/api/auth/poll', async (req, res) => {
  try {
    const { deviceCode } = req.body;
    
    // 1. Poll status pending/approved
    const pollRes = await fetch(`https://${config.serverIp}/api/auth/device-code/poll`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ deviceCode })
    });
    const pollData = await pollRes.json();
    
    if (pollData.data?.status !== 'success' || !pollData.data.token) {
      // ainda pending
      return res.json({ status: 'pending' });
    }
    
    // 2. Troca linkToken (5 min) por JWT de sessão (7 dias)
    const loginRes = await fetch(`https://${config.serverIp}/api/auth/qr-login`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ linkToken: pollData.data.token })
    });
    const loginData = await loginRes.json();
    if (!loginData.data?.token) throw new Error('Troca por JWT falhou');
    const jwt = loginData.data.token;
    
    // 3. Cria Node REAL no banco
    const nodeRes = await fetch(`https://${config.serverIp}/api/nodes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${jwt}`
      },
      body: JSON.stringify({ deviceName: 'HiveDocker', visibility: 'PUBLIC' })
    });
    const nodeData = await nodeRes.json();
    if (!nodeData.data?.node?.id) throw new Error(`Falha ao criar node: ${nodeData.error || ''}`);
    
    // 4. Persistir
    config.linkToken = null; // linkToken já foi trocado
    config.token = jwt;
    config.tunnelSecret = loginData.data.user?.tunnelSecret || "hivenode_secret_key";
    config.nodeId = nodeData.data.node.id;
    saveConfig();
    
    res.json({ status: 'success' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});


app.post('/api/logout', (_req, res) => {
  stopTunnel();
  config.nodeId = null;
  config.linkToken = null;
  saveConfig();
  res.json({ success: true });
});

let server;

function gracefulShutdown(signal) {
  addLog(`🛑 ${signal} recebido. Encerrando graciosamente...`);
  
  if (ws) {
    ws.close();
    ws = null;
  }
  
  if (server) {
    server.close(() => {
      addLog('✅ Shutdown completo');
      process.exit(0);
    });
    
    setTimeout(() => process.exit(1), 5000).unref();
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

server = app.listen(8080, '0.0.0.0', () => {
  console.log('HiveDocker running on http://0.0.0.0:8080');
});

function getStatusData() {
  return {
    nodeId: config.nodeId,
    nodeName: config.nodeName,
    isConnected,
    uptime: tunnelStartTime ? Math.floor((Date.now() - tunnelStartTime) / 1000) : 0,
    logs: logs.slice(0, 20)
  };
}

const wss = new WebSocket.Server({ server });

wss.on('connection', (client, req) => {
  // Opcional: proteger o WS tb
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  if (process.env.HIVEDOCKER_PUBLIC !== 'true' && token !== config.panelToken) {
    client.close(4001, "Unauthorized");
    return;
  }
  
  client.send(JSON.stringify({ type: 'status', data: getStatusData() }));
});

function broadcastUpdate() {
  if (!wss) return;
  const payload = JSON.stringify({ type: 'status', data: getStatusData() });
  wss.clients.forEach((c) => {
    if (c.readyState === 1) c.send(payload);
  });
}
