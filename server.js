const express = require('express');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const CryptoJS = require('crypto-js');
const net = require('net');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const CONFIG_FILE = path.join(__dirname, 'config.json');

let config = { serverIp: 'api.hivenode.alfastage.com.br', nodeId: null, linkToken: null };
try {
  if (fs.existsSync(CONFIG_FILE)) {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  }
} catch (e) { console.error('Error reading config', e); }

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

let ws = null;
let isConnected = false;
let logs = [];
let tunnelStartTime = null;

function addLog(msg) {
  const time = new Date().toLocaleTimeString();
  const logStr = \`[\${time}] \${msg}\`;
  logs.unshift(logStr);
  if (logs.length > 100) logs.pop();
  console.log(logStr);
}

function startTunnel() {
  if (!config.nodeId) {
    addLog("Erro: Aparelho não vinculado");
    return;
  }
  if (ws) {
    ws.close();
  }

  const hmacSig = CryptoJS.HmacSHA256(config.nodeId, "hivenode_secret_key").toString(CryptoJS.enc.Hex);
  const wsUrl = \`wss://\${config.serverIp}/tunnel?nodeId=\${config.nodeId}&sig=\${hmacSig}\`;

  addLog("Conectando ao Broker...");
  ws = new WebSocket(wsUrl);
  
  const activeSockets = {};

  ws.on('open', () => {
    isConnected = true;
    tunnelStartTime = Date.now();
    addLog("✅ Túnel TCP Reverso Conectado!");
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

      if (type === "DIAL") {
        addLog(\`[\${connId}] Requisição TCP -> \${host}\`);
        const [targetHost, targetPort] = host.split(":");
        const client = new net.Socket();
        
        client.connect(parseInt(targetPort) || 80, targetHost, () => {
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
          addLog(\`❌ [\${connId}] Erro TCP: \${err.message}\`);
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
      addLog("Erro pacotes JSON: " + e.message);
    }
  });

  ws.on('close', () => {
    isConnected = false;
    tunnelStartTime = null;
    addLog("🛑 Túnel Desconectado.");
    Object.values(activeSockets).forEach(s => s.destroy());
    ws = null;
  });

  ws.on('error', (e) => {
    addLog("❌ Erro WebSocket: " + e.message);
  });
}

function stopTunnel() {
  if (ws) {
    ws.close();
    ws = null;
  }
}

// API Routes
app.get('/api/status', (req, res) => {
  res.json({
    nodeId: config.nodeId,
    isConnected,
    uptime: tunnelStartTime ? Math.floor((Date.now() - tunnelStartTime) / 1000) : 0,
    logs: logs.slice(0, 20)
  });
});

app.post('/api/tunnel/start', (req, res) => {
  startTunnel();
  res.json({ success: true });
});

app.post('/api/tunnel/stop', (req, res) => {
  stopTunnel();
  res.json({ success: true });
});

// A simple local device-code flow
app.post('/api/auth/start', async (req, res) => {
  try {
    const response = await fetch(\`https://\${config.serverIp}/api/auth/device-code/generate\`, {
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
    const response = await fetch(\`https://\${config.serverIp}/api/auth/device-code/poll\`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ deviceCode })
    });
    const data = await response.json();
    
    if (data.status === 'success' && data.token) {
      // Mock node id registration (in reality the device should register to /nodes but we will just generate a local id for now)
      config.linkToken = data.token;
      config.nodeId = 'DOCKER-' + Math.random().toString(36).substring(2, 10).toUpperCase();
      saveConfig();
    }
    
    res.json(data);
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});


app.post('/api/logout', (req, res) => {
  stopTunnel();
  config.nodeId = null;
  config.linkToken = null;
  saveConfig();
  res.json({ success: true });
});

app.listen(8080, '0.0.0.0', () => {
  console.log('HiveDocker running on http://0.0.0.0:8080');
});
