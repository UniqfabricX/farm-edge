#!/usr/bin/env node
'use strict';

/**
 * farm-edge-agent — outbound WSS bridge to farm-control-saas.
 *
 * Usage:
 *   node index.js pair --code ABCD-EFGH [--cloud https://farm.5dsap.ru]
 *   node index.js run
 *   node index.js status
 *
 * Env:
 *   EDGE_CLOUD_URL   default https://farm.5dsap.ru
 *   FARM_BFF_URL     default http://127.0.0.1:3001 (localhost/private only)
 *   FARM_EDGE_DATA   credential directory
 */

const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { URL } = require('url');
const WebSocket = require('ws');
const {
  VERSION,
  defaultDataDir,
  ensureDataDir,
  loadCredentials,
  saveCredentials,
  cloudHttpBase,
  farmBffUrl,
} = require('./config');
const { handleRpc, lanHint } = require('./rpc-handler');

// Upload limit in SaaS is 200 MB raw; base64 + JSON needs ~267 MB.
// This applies only to the authenticated cloud → Edge channel.
const EDGE_RPC_MAX_PAYLOAD = parseInt(
  process.env.EDGE_RPC_MAX_PAYLOAD || String(300 * 1024 * 1024),
  10
);

function log(...a) {
  console.log(new Date().toISOString(), '[farm-edge]', ...a);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--code' || a === '-c') out.code = argv[++i];
    else if (a === '--cloud') out.cloud = argv[++i];
    else if (a === '--data') out.data = argv[++i];
    else if (a === '--bff') out.bff = argv[++i];
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i] || true;
    else out._.push(a);
  }
  return out;
}

function postJson(urlStr, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const req = lib.request(
      {
        method: 'POST',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
          Accept: 'application/json',
        },
        timeout: 20000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data = {};
          try {
            data = JSON.parse(text || '{}');
          } catch {
            data = { raw: text };
          }
          if (res.statusCode >= 400) {
            const err = new Error(data.error || `HTTP ${res.statusCode}`);
            err.code = data.code;
            err.status = res.statusCode;
            return reject(err);
          }
          resolve(data);
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(Object.assign(new Error('Cloud request timeout'), { code: 'CLOUD_TIMEOUT' }));
    });
    req.write(payload);
    req.end();
  });
}

async function cmdPair(opts) {
  const dataDir = opts.data || defaultDataDir();
  ensureDataDir(dataDir);
  const cloud = cloudHttpBase(opts.cloud || process.env.EDGE_CLOUD_URL);
  const code = opts.code;
  if (!code) {
    console.error('Usage: node index.js pair --code ABCD-EFGH [--cloud https://farm.5dsap.ru]');
    process.exit(2);
  }
  log('claiming pair code against', cloud);
  const claimed = await postJson(`${cloud}/api/edge/pair/claim`, {
    code,
    hostname: os.hostname(),
    name: os.hostname(),
    agentVersion: VERSION,
    website: '', // honeypot empty
  });
  if (!claimed || !claimed.agentId || !claimed.agentSecret || !claimed.cloudWsUrl) {
    throw new Error('Pair response is missing agentId / agentSecret / cloudWsUrl');
  }
  const creds = {
    agentId: claimed.agentId,
    agentSecret: claimed.agentSecret,
    cloudWsUrl: claimed.cloudWsUrl,
    cloudHttpUrl: cloud,
    tenantId: claimed.tenantId,
    farmBffUrl: opts.bff || farmBffUrl(),
    pairedAt: new Date().toISOString(),
    hostname: os.hostname(),
    agentVersion: VERSION,
  };
  saveCredentials(dataDir, creds);
  log('paired OK agentId=', creds.agentId);
  log('credentials saved under', dataDir, '(mode 600)');
  log('start with: node index.js run');
}

function cmdStatus(opts) {
  const dataDir = opts.data || defaultDataDir();
  const creds = loadCredentials(dataDir);
  if (!creds) {
    console.log(JSON.stringify({ paired: false, dataDir }, null, 2));
    return;
  }
  console.log(
    JSON.stringify(
      {
        paired: true,
        dataDir,
        agentId: creds.agentId,
        cloudWsUrl: creds.cloudWsUrl,
        farmBffUrl: creds.farmBffUrl || farmBffUrl(),
        hostname: creds.hostname,
        agentVersion: creds.agentVersion || VERSION,
        lanHint: lanHint(),
      },
      null,
      2
    )
  );
}

function connectLoop(creds) {
  let backoffMs = 2000;
  let stopped = false;
  let hbTimer = null;

  function schedule() {
    if (stopped) return;
    setTimeout(connect, backoffMs);
  }

  function connect() {
    if (stopped) return;
    const wsUrl = new URL(creds.cloudWsUrl);
    wsUrl.searchParams.set('agentId', creds.agentId);
    wsUrl.searchParams.set('hostname', os.hostname());
    wsUrl.searchParams.set('v', VERSION);

    log('connecting', wsUrl.origin + wsUrl.pathname);
    const ws = new WebSocket(wsUrl.toString(), {
      headers: {
        'X-Edge-Agent-Id': creds.agentId,
        'X-Edge-Secret': creds.agentSecret,
      },
      handshakeTimeout: 20000,
      maxPayload: EDGE_RPC_MAX_PAYLOAD,
    });

    ws.on('open', () => {
      log('online');
      backoffMs = 2000;
      if (hbTimer) clearInterval(hbTimer);
      hbTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: 'heartbeat',
              agentVersion: VERSION,
              hostname: os.hostname(),
              lanHint: lanHint(),
              ts: Date.now(),
            })
          );
        }
      }, 25000);
      if (hbTimer.unref) hbTimer.unref();
    });

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === 'rpc' && msg.id) {
        let result;
        try {
          if (creds.farmBffUrl) process.env.FARM_BFF_URL = creds.farmBffUrl;
          result = await handleRpc(msg);
        } catch (e) {
          result = {
            status: e.status || 500,
            body: { error: e.message || String(e), code: e.code || 'EDGE_HANDLER' },
          };
        }
        const out = {
          type: 'rpc_result',
          id: msg.id,
          ok: (result.status || 200) < 400,
          status: result.status || 200,
          body: result.body,
          binaryBase64: result.binaryBase64,
          contentType: result.contentType,
          cacheControl: result.cacheControl,
          headers: result.headers,
          error: result.body && result.body.error,
          code: result.body && result.body.code,
        };
        try {
          ws.send(JSON.stringify(out));
        } catch (e) {
          log('send rpc_result failed', e.message);
        }
      }
    });

    ws.on('close', (code, reason) => {
      log('disconnected', code, String(reason || ''));
      if (hbTimer) clearInterval(hbTimer);
      backoffMs = Math.min(backoffMs * 1.6, 60000);
      schedule();
    });

    ws.on('error', (err) => {
      log('ws error', err.message);
    });
  }

  connect();
  return () => {
    stopped = true;
    if (hbTimer) clearInterval(hbTimer);
  };
}

async function cmdRun(opts) {
  const dataDir = opts.data || defaultDataDir();
  const creds = loadCredentials(dataDir);
  if (!creds || !creds.agentId || !creds.agentSecret || !creds.cloudWsUrl) {
    console.error('Not paired. Run: node index.js pair --code YOUR-CODE');
    process.exit(2);
  }
  // Prevent two agents fighting over the same cloud session (WS close 4002 replaced).
  try {
    const fs = require('fs');
    const lockPath = path.join(dataDir, 'agent.run.lock');
    if (fs.existsSync(lockPath)) {
      const oldPid = Number(String(fs.readFileSync(lockPath, 'utf8')).trim());
      if (oldPid && oldPid !== process.pid) {
        try {
          process.kill(oldPid, 0);
          console.error('[farm-edge] another agent already running (pid ' + oldPid + '). Exit.');
          process.exit(0);
        } catch {
          /* stale lock */
        }
      }
    }
    fs.writeFileSync(lockPath, String(process.pid), { mode: 0o600 });
    const clear = () => {
      try {
        if (String(fs.readFileSync(lockPath, 'utf8')).trim() === String(process.pid)) fs.unlinkSync(lockPath);
      } catch {}
    };
    process.on('exit', clear);
    process.on('SIGINT', () => {
      clear();
      process.exit(0);
    });
    process.on('SIGTERM', () => {
      clear();
      process.exit(0);
    });
  } catch (e) {
    console.warn('[farm-edge] lock skipped:', e.message);
  }
  if (opts.bff) {
    creds.farmBffUrl = opts.bff;
    saveCredentials(dataDir, creds);
  }
  if (creds.farmBffUrl) process.env.FARM_BFF_URL = creds.farmBffUrl;
  log('agent', creds.agentId, 'bff', process.env.FARM_BFF_URL || farmBffUrl());
  try {
    const pathMod = require('path');
    const whCandidates = [
      pathMod.join(__dirname, 'lib', 'server', 'warehouse.js'),
      pathMod.join(__dirname, '..', 'src', 'server', 'warehouse.js'),
    ];
    const whPath = whCandidates.find((p) => require('fs').existsSync(p));
    if (!whPath) throw new Error('warehouse.js not found');
    const warehouse = require(whPath);
    if (warehouse.ensureDirs) warehouse.ensureDirs();
    if (warehouse.syncFromFarmBff) {
      const sync = warehouse.syncFromFarmBff();
      if (sync && sync.ok) log('warehouse sync farm-bff', `imported=${sync.imported} total=${sync.total}`);
      else if (sync && sync.error) log('warehouse sync skip', sync.error);
    }
  } catch (e) {
    log('warehouse init skip', e.message);
  }
  connectLoop(creds);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cmd = opts._[0] || 'run';
  if (opts.cloud) process.env.EDGE_CLOUD_URL = opts.cloud;
  if (opts.bff) process.env.FARM_BFF_URL = opts.bff;

  if (cmd === 'pair') return cmdPair(opts);
  if (cmd === 'status') return cmdStatus(opts);
  if (cmd === 'run' || cmd === 'start') return cmdRun(opts);
  console.error('Commands: pair | run | status');
  process.exit(2);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
