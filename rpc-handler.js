'use strict';

/**
 * Allowlisted RPC execution on the home PC.
 * - warehouse / scan: local SaaS modules (any LAN via os.networkInterfaces)
 * - printers: farm-bff board (+ passthrough allowlist)
 * Never follows arbitrary URLs; FARM_BFF_URL must be loopback or private RFC1918.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { farmBffUrl, defaultDataDir, ensureDataDir } = require('./config');

function localPrintersPath() {
  const dir = typeof defaultDataDir === 'function' ? defaultDataDir() : (process.env.FARM_EDGE_DATA || path.join(process.env.ProgramData || 'C:\\ProgramData', 'farm-edge'));
  try {
    if (typeof ensureDataDir === 'function') ensureDataDir(dir);
    else fs.mkdirSync(dir, { recursive: true });
  } catch {}
  return path.join(dir, 'printers.json');
}

function loadLocalEdgePrinters() {
  try {
    const p = localPrintersPath();
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Array.isArray(data)) return data;
      if (data && Array.isArray(data.printers)) return data.printers;
    }
  } catch {}
  return [];
}

function saveLocalEdgePrinter(printer) {
  try {
    const p = localPrintersPath();
    let list = loadLocalEdgePrinters();
    const idx = list.findIndex(x => x.id === printer.id || (x.ip && x.ip === printer.ip));
    if (idx >= 0) {
      list[idx] = { ...list[idx], ...printer };
    } else {
      list.push(printer);
    }
    fs.writeFileSync(p, JSON.stringify(list, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.warn('[edge] saveLocalEdgePrinter error:', e.message);
    return false;
  }
}

function resolveServerRoot() {
  const candidates = [
    path.join(__dirname, 'lib', 'server'),
    path.join(__dirname, '..', 'src', 'server'),
    process.env.FARM_EDGE_SERVER_ROOT,
  ].filter(Boolean);
  for (const root of candidates) {
    try {
      if (require('fs').existsSync(path.join(root, 'scanner.js'))) return root;
    } catch {}
  }
  return candidates[0] || path.join(__dirname, 'lib', 'server');
}

const SERVER_ROOT = resolveServerRoot();

let scanner;
let warehouse;
try {
  scanner = require(path.join(SERVER_ROOT, 'scanner.js'));
} catch (e) {
  console.warn('[edge] scanner module missing:', e.message, 'root=', SERVER_ROOT);
}
try {
  warehouse = require(path.join(SERVER_ROOT, 'warehouse.js'));
} catch (e) {
  console.warn('[edge] warehouse module missing:', e.message, 'root=', SERVER_ROOT);
}

function assertLocalBff(base) {
  let u;
  try {
    u = new URL(base);
  } catch {
    throw Object.assign(new Error('Invalid FARM_BFF_URL'), { code: 'BFF_URL', status: 500 });
  }
  const host = u.hostname;
  const ok =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
  if (!ok) {
    throw Object.assign(new Error('FARM_BFF_URL must be localhost or private LAN'), {
      code: 'BFF_SSRF',
      status: 403,
    });
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw Object.assign(new Error('FARM_BFF_URL protocol not allowed'), { code: 'BFF_SSRF', status: 403 });
  }
}

function isPrivateIpv4(ip) {
  const s = String(ip || '').trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return false;
  const o = s.split('.').map(Number);
  if (o.some((n) => n > 255)) return false;
  return o[0] === 10 || (o[0] === 192 && o[1] === 168) || (o[0] === 172 && o[1] >= 16 && o[1] <= 31);
}

/** LAN IP of a Klipper printer by id: local edge list, then an IP embedded in the id. */
function moonrakerIpFor(printerId) {
  const local = loadLocalEdgePrinters().find((p) => p && p.id === printerId);
  const candidates = [
    local && (local.ip || local.ip_address),
    (String(printerId).match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/) || [])[1],
    ((String(printerId).match(/(\d{1,3}-\d{1,3}-\d{1,3}-\d{1,3})$/) || [])[1] || '').replace(/-/g, '.'),
  ];
  return candidates.find((ip) => isPrivateIpv4(ip)) || null;
}

function isAllowedPath(p) {
  if (!p || p.includes('..')) return false;
  // Never expose privileged / destructive server control via edge.
  if (p === '/api/server/restart' || p.startsWith('/api/server/')) return false;
  if (p === '/api/logs' || p.startsWith('/api/logs/')) return false;
  return (
    p === '/api/network' ||
    p === '/api/bambu/listen' ||
    p === '/api/bambu/accesscode' ||
    p === '/api/flashforge/checkcode' ||
    p === '/api/creality/ssh-password' ||
    p === '/api/printers' ||
    p.startsWith('/api/printers/') ||
    p === '/api/scan' ||
    p.startsWith('/api/scan/') ||
    p === '/api/warehouse' ||
    p.startsWith('/api/warehouse/') ||
    p === '/api/board' ||
    p.startsWith('/api/board/') ||
    p.startsWith('/api/otm/') ||
    p === '/api/print-plan' ||
    p.startsWith('/api/print-plan/') ||
    p === '/api/planning' ||
    p.startsWith('/api/planning/') ||
    p === '/api/launch-jobs' ||
    p.startsWith('/api/launch-jobs/') ||
    p.startsWith('/api/upload/') ||
    p === '/api/orders' ||
    p.startsWith('/api/orders/') ||
    p === '/api/layout' ||
    p.startsWith('/api/layout/') ||
    p === '/api/gcode-profiles' ||
    p.startsWith('/api/gcode-profiles/') ||
    p === '/api/parts' ||
    p.startsWith('/api/parts/') ||
    p.startsWith('/api/farm/') ||
    p === '/api/dashboard' ||
    p.startsWith('/api/dashboard/') ||
    p === '/api/production' ||
    p.startsWith('/api/production/') ||
    p === '/api/part-weights' ||
    p.startsWith('/api/part-weights/') ||
    p === '/api/cameras/status' ||
    p === '/api/cameras/detect-all' ||
    p === '/api/maintenance/logs' ||
    p.startsWith('/api/maintenance/logs/')
  );
}

function bffTimeoutFor(pathname, method) {
  if (pathname.startsWith('/api/maintenance/logs')) {
    return 300_000;
  }
  if (pathname.startsWith('/api/upload/') || pathname.includes('/gcode') || pathname.includes('/cad')) {
    return 180_000;
  }
  if (pathname.startsWith('/api/otm/') || pathname === '/api/print-plan' || pathname.startsWith('/api/print-plan/')) {
    return 90_000;
  }
  if (pathname === '/api/board' || pathname.startsWith('/api/board/')) return 60_000;
  if (method === 'GET' && pathname === '/api/printers') return 120_000;
  return 45_000;
}

/**
 * Folders where a co-located farm-bff may live: FARM_BFF_DIR, then sibling
 * checkouts next to the agent. No absolute per-machine paths — the agent ships
 * to client PCs where they would point at someone else's files.
 */
function farmBffDirCandidates() {
  return [
    process.env.FARM_BFF_DIR,
    path.join(__dirname, '..', 'farm-bff'),
    path.join(__dirname, '..', '..', 'farm-bff'),
  ].filter(Boolean);
}

let cachedFileToken;
function fileBffToken() {
  if (cachedFileToken !== undefined) return cachedFileToken;
  cachedFileToken = '';
  const dataDir = typeof defaultDataDir === 'function' ? defaultDataDir() : null;
  const candidates = [
    dataDir && path.join(dataDir, '.farm-token'),
    ...farmBffDirCandidates().map((d) => path.join(d, '.farm-token')),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (!fs.existsSync(c)) continue;
      const t = fs.readFileSync(c, 'utf8').trim();
      if (t) {
        cachedFileToken = t;
        break;
      }
    } catch {}
  }
  return cachedFileToken;
}

function bffAuthHeaders() {
  const token = String(process.env.FARM_BFF_TOKEN || '').trim() || fileBffToken();
  if (!token) return {};
  return { Authorization: 'Bearer ' + token };
}

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{6,64}$/;
/** Сквозной X-Request-Id из RPC-сообщения SaaS (поле requestId или заголовок). */
function requestIdFromMsg(msg) {
  const raw =
    (msg && msg.requestId) ||
    (msg && msg.headers && (msg.headers['x-request-id'] || msg.headers['X-Request-Id'])) ||
    '';
  const s = String(raw || '').trim();
  return REQUEST_ID_RE.test(s) ? s : '';
}

function httpJson(method, urlStr, { body, binary, timeoutMs = 20000, contentType, headers, noAuth = false } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const payload = binary
      ? binary
      : body != null
        ? Buffer.from(JSON.stringify(body), 'utf8')
        : null;
    // The farm-bff token must never reach a printer's own HTTP API.
    const auth = noAuth ? {} : bffAuthHeaders();
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers: {
          Accept: 'application/json',
          ...auth,
          ...(headers || {}),
          ...(payload && !binary ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
          ...(payload && binary
            ? {
                'Content-Type': contentType || 'application/octet-stream',
                'Content-Length': payload.length,
              }
            : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const ct = String(res.headers['content-type'] || '');
          if (ct.includes('application/json') || buf[0] === 0x7b || buf[0] === 0x5b) {
            try {
              resolve({ status: res.statusCode || 200, body: JSON.parse(buf.toString('utf8') || 'null') });
            } catch {
              resolve({ status: res.statusCode || 200, body: buf.toString('utf8') });
            }
          } else {
            resolve({
              status: res.statusCode || 200,
              binaryBase64: buf.toString('base64'),
              contentType: ct || 'application/octet-stream',
            });
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(Object.assign(new Error('BFF timeout'), { code: 'BFF_TIMEOUT', status: 504 }));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

const TELEMETRY_LINE_RE = /^(Сопло|Стол|Прогресс|Пинг|Проверка связи|Последний известный статус)/i;
const PAUSE_LINE_RE = /^(Печать на паузе|Пауза|Причина:)/i;
const COMPLETE_LINE_RE = /^(Печать завершена|Печать окончена|Требуется учёт|Учёт:)/i;
function firstNonTelemetryDetail(detail) {
  if (!Array.isArray(detail)) return null;
  for (const line of detail) {
    const s = String(line || '');
    if (s && !TELEMETRY_LINE_RE.test(s) && !PAUSE_LINE_RE.test(s) && !COMPLETE_LINE_RE.test(s)) return s;
  }
  return null;
}

function mapBoardToPrinters(board) {
  const rows = board.printers || board.tiles || [];
  return rows.map((p) => {
    const id = p.printerId || p.id;
    const progNum = Number(p.progress);
    const has100 = Number.isFinite(progNum) && progNum >= 100;
    const isCompleted = p.plate === 'print_complete' || has100;
    const isPaused = !isCompleted && (p.plate === 'paused' || p.plate === 'filament_change');
    let status = isCompleted ? 'completed' : (isPaused ? 'paused' : mapPlateToStatus(p));

    const ip = p.ip || null;
    const nozzle = p.nozzleTemp != null ? Number(p.nozzleTemp) : null;
    const bed = p.bedTemp != null ? Number(p.bedTemp) : null;
    // Camera: farm-bff board marks printers with a usable camera (Bambu with LAN code,
    // Creality/Flashforge/Elegoo with cameraPort/cameraUrl). Only browser-playable http(s)
    // URLs are forwarded — never rtsps:// with embedded access code.
    // Новый farm-bff считает hasCameraHint из авто-обнаружения (camera-detect: 📷 только у
    // проверенных камер). cameraPort/cameraUrl — fallback только для старого BFF без этого поля.
    const hasCamera = p.hasCameraHint !== undefined ? Boolean(p.hasCameraHint) : Boolean(p.cameraPort || p.cameraUrl);
    const cameraUrl = p.cameraUrl && /^https?:\/\//i.test(String(p.cameraUrl)) ? String(p.cameraUrl) : null;

    let error_message = null;
    if (isCompleted || status === 'completed') {
      error_message = null; // При 100% / завершении печати никакой ошибки быть не может!
    } else if (isPaused || status === 'paused') {
      error_message = null; // При паузе это не ошибка!
    } else if (status === 'error' || p.plate === 'error') {
      error_message = p.errorMessage || firstNonTelemetryDetail(p.plateDetail) || null;
    } else if (p.errorMessage && !/печать на паузе|^пауза|печать завершена|печать окончена|printer is ready|operational|finished printing/i.test(p.errorMessage)) {
      error_message = p.errorMessage;
    }
    if (error_message && /printer is ready|operational|finished printing|^idle$|^standby$/i.test(error_message)) {
      error_message = null;
    }

    return {
      id,
      name: p.printerName || p.name || id,
      status,
      print_status: status,
      has_camera: hasCamera,
      camera_status: p.cameraStatus || null,
      camera_port: p.cameraPort || null,
      cameraUrl,
      progress: p.progress != null ? Number(p.progress) : null,
      job_name: p.filename || p.jobName || null,
      ip,
      ip_address: ip,
      type: p.printerType || p.type || null,
      model: p.bambuModel || p.model || null,
      bambuModel: p.bambuModel || null,
      group: p.printerGroup || p.group || null,
      plate: isCompleted ? 'print_complete' : p.plate,
      plateLabel: isCompleted ? 'Печать окончена' : (p.plateLabel || null),
      plateDetail: Array.isArray(p.plateDetail) ? p.plateDetail : null,
      error_message,
      material: p.material || p.filament || null,
      nozzle_temp: nozzle,
      bed_temp: bed,
      temp_nozzle: nozzle,
      temp_bed: bed,
      source: 'edge-bff',
      online: status !== 'offline',
      is_online: status !== 'offline',
    };
  });
}

function mapPlateToStatus(p) {
  const prog = Number(p.progress);
  if (Number.isFinite(prog) && prog >= 100) return 'completed';
  const plate = String(p.plate || '').toLowerCase();
  if (plate === 'printing') return 'printing';
  if (plate === 'paused' || plate === 'filament_change') return 'paused';
  if (plate === 'print_complete') return 'completed';
  if (plate === 'error') return 'error';
  if (plate === 'tech') return 'warning';
  if (plate === 'offline') return 'offline';
  if (plate === 'idle') return 'idle';
  if (p.online === false) return 'offline';
  const st = String(p.state || p.displayState || '').toLowerCase();
  if (st.includes('finish') || st.includes('complete')) return 'completed';
  if (!st || st === 'offline' || st === 'timeout' || st === 'unreachable' || st === 'unsupported' || st === 'none') {
    return 'offline';
  }
  if (st.includes('print') || st === 'running' || st === 'prepare' || st === 'preparing') return 'printing';
  if (st.includes('pause')) return 'paused';
  if (st.includes('error') || st === 'failed') return 'error';
  if (st.includes('finish') || st.includes('complete')) return 'completed';
  return 'idle';
}

function lanHint() {
  const ifaces = os.networkInterfaces();
  const out = [];
  for (const [name, list] of Object.entries(ifaces || {})) {
    for (const row of list || []) {
      if (row.family !== 'IPv4' && row.family !== 4) continue;
      if (row.internal) continue;
      out.push({ name, address: row.address });
    }
  }
  return out.slice(0, 8);
}

async function handleWarehouse(method, pathname, query, body, bodyBinaryBase64) {
  if (!warehouse) {
    return { status: 501, body: { error: 'warehouse module unavailable on edge', code: 'NO_WAREHOUSE' } };
  }
  try {
    if (pathname === '/api/warehouse/status' && method === 'GET') {
      return { status: 200, body: warehouse.status() };
    }
    if (pathname === '/api/warehouse/parts' && method === 'GET') {
      return { status: 200, body: warehouse.listWarehouse(query) };
    }
    if (pathname.match(/^\/api\/warehouse\/parts\/[^/]+$/) && method === 'GET') {
      const id = decodeURIComponent(pathname.split('/')[4]);
      const card = warehouse.getPartCard(id);
      if (!card) return { status: 404, body: { error: 'Деталь не найдена' } };
      return { status: 200, body: card };
    }
    if (pathname.match(/^\/api\/warehouse\/parts\/[^/]+\/image$/) && method === 'GET') {
      const id = decodeURIComponent(pathname.split('/')[4]);
      const img = warehouse.readImage(id);
      if (!img) return { status: 404, body: { error: 'Нет изображения' } };
      return {
        status: 200,
        binaryBase64: img.buffer.toString('base64'),
        contentType: img.contentType,
        cacheControl: 'private, max-age=120',
      };
    }
    if (pathname === '/api/warehouse/plan' && method === 'GET') {
      return { status: 200, body: warehouse.listPlan() };
    }
    if (pathname === '/api/warehouse/journal' && method === 'GET') {
      return {
        status: 200,
        body: warehouse.listCollectJournal({
          limit: query.limit,
          today: query.today === '1' || query.today === 'true',
          date: query.date || null,
        }),
      };
    }
    if (pathname === '/api/warehouse/scrap-reasons' && method === 'GET') {
      return { status: 200, body: { ok: true, reasons: warehouse.scrapReasons() } };
    }
    if (pathname === '/api/warehouse/sync-bff' && method === 'POST') {
      return { status: 200, body: warehouse.syncFromFarmBff() };
    }
    if (pathname === '/api/warehouse/parts' && method === 'POST') {
      const part = warehouse.upsertPart(body || {});
      return { status: 200, body: { ok: true, part: warehouse.getPartCard(part.partId)?.part || part } };
    }
    if (pathname.match(/^\/api\/warehouse\/parts\/[^/]+\/cad$/) && method === 'POST') {
      const id = decodeURIComponent(pathname.split('/')[4]);
      const buf = Buffer.from(bodyBinaryBase64 || '', 'base64');
      const part = warehouse.saveCadBuffer(id, {
        kind: (query.kind || 'stl').toString(),
        fileName: (query.filename || `model.${query.kind || 'stl'}`).toString(),
        buffer: buf,
      });
      return { status: 200, body: { ok: true, part: warehouse.getPartCard(part.partId)?.part || part } };
    }
    if (pathname.match(/^\/api\/warehouse\/parts\/[^/]+\/image$/) && method === 'POST') {
      const id = decodeURIComponent(pathname.split('/')[4]);
      const buf = Buffer.from(bodyBinaryBase64 || '', 'base64');
      const part = warehouse.saveImageBuffer(id, {
        fileName: (query.filename || 'photo.jpg').toString(),
        buffer: buf,
      });
      return { status: 200, body: { ok: true, part: warehouse.getPartCard(part.partId)?.part || part } };
    }
    if (pathname.match(/^\/api\/warehouse\/parts\/[^/]+\/gcode$/) && method === 'POST') {
      const id = decodeURIComponent(pathname.split('/')[4]);
      const buf = Buffer.from(bodyBinaryBase64 || '', 'base64');
      const profile = warehouse.addGcodeProfile({
        partId: id,
        fileName: (query.filename || 'job.gcode').toString(),
        buffer: buf,
      });
      return { status: 200, body: { ok: true, profile, part: warehouse.getPartCard(id)?.part } };
    }
    if (pathname === '/api/warehouse/plan' && method === 'POST') {
      const item = warehouse.addPlanItem(body || {});
      return { status: 200, body: { ok: true, item } };
    }
    if (pathname.match(/^\/api\/warehouse\/plan\/[^/]+$/) && method === 'DELETE') {
      const id = decodeURIComponent(pathname.split('/')[4]);
      return { status: 200, body: warehouse.removePlanItem(id) };
    }
    if (pathname.match(/^\/api\/warehouse\/plan\/[^/]+\/enqueue$/) && method === 'POST') {
      return {
        status: 501,
        body: { error: 'Enqueue via SaaS queue not available on edge v1 — use farm-bff print-plan', code: 'EDGE_LIMIT' },
      };
    }
    if (pathname === '/api/warehouse/collect' && method === 'POST') {
      return { status: 200, body: await warehouse.applyCollect(body || {}) };
    }
    if (pathname === '/api/warehouse/scrap' && method === 'POST') {
      return { status: 200, body: await warehouse.applyScrap(body || {}) };
    }
    if (pathname === '/api/warehouse/stock' && method === 'POST') {
      return { status: 200, body: await warehouse.applyStockSettings(body || {}) };
    }
    return { status: 404, body: { error: 'Unknown warehouse path on edge' } };
  } catch (e) {
    return { status: 400, body: { error: e.message || String(e) } };
  }
}

async function enrichScanState(state) {
  if (!state || !Array.isArray(state.found) || !state.found.length) return state;
  try {
    const bff = farmBffUrl();
    assertLocalBff(bff);
    const r = await httpJson('GET', `${bff}/api/printers/scan-enrich`, { timeoutMs: 15000 });
    if (r.status >= 400 || !r.body || !r.body.byIp) return state;
    const found = state.found.map((d) => {
      const hint = r.body.byIp[String(d.ip || '').trim()];
      if (!hint) return d;
      const cfg = { ...(d.config || {}) };
      if (hint.serial) cfg.serial = hint.serial;
      if (hint.access_code) cfg.access_code = hint.access_code;
      if (hint.flashforgeSerial) cfg.flashforgeSerial = hint.flashforgeSerial;
      if (hint.flashforgeCheckCode) {
        cfg.flashforgeCheckCode = hint.flashforgeCheckCode;
        cfg.checkCode = hint.flashforgeCheckCode;
      }
      if (hint.mainboard_id) {
        cfg.mainboard_id = hint.mainboard_id;
        cfg.mainboardId = hint.mainboard_id;
      }
      return {
        ...d,
        in_pool: true,
        bff_id: hint.id,
        name: hint.name || d.name,
        config: cfg,
        notes: d.notes
          ? `${d.notes} · уже в farm-bff (${hint.id})`
          : `Уже в farm-bff (${hint.id})`,
      };
    });
    return { ...state, found, enrichCount: Object.keys(r.body.byIp).length };
  } catch (e) {
    console.warn('[edge] scan-enrich failed:', e.message || e);
    return state;
  }
}

async function handleScan(method, pathname, query, body) {
  if (!scanner) {
    return { status: 501, body: { error: 'scanner unavailable', code: 'NO_SCANNER' } };
  }
  if (pathname === '/api/network' && method === 'GET') {
    const info = typeof scanner.getNetworkInfo === 'function'
      ? scanner.getNetworkInfo()
      : { subnets: scanner.getLocalSubnets() };
    return { status: 200, body: { ...info, via: 'edge' } };
  }
  if (pathname === '/api/scan/status' && method === 'GET') {
    const state = await enrichScanState(scanner.getScanState());
    return { status: 200, body: state };
  }
  if (pathname === '/api/scan/stop' && method === 'GET') {
    return { status: 200, body: scanner.stopScan() };
  }
  if (pathname === '/api/scan/clear' && method === 'GET') {
    return { status: 200, body: scanner.clearScan() };
  }
  if (pathname === '/api/scan' && method === 'GET') {
    const opts = {};
    if (query.subnets) opts.prefixes = String(query.subnets).split(',').map((s) => s.trim()).filter(Boolean);
    const result = await scanner.startScan(opts);
    return { status: 200, body: result };
  }
  if (pathname === '/api/scan/probe' && method === 'POST') {
    const ip = String((body && body.ip) || '').trim();
    if (!isPrivateIpv4(ip)) {
      return { status: 400, body: { ok: false, error: 'ip must be a private LAN IPv4', code: 'BAD_IP' } };
    }
    if (typeof scanner.probeIp !== 'function') {
      return { status: 501, body: { ok: false, error: 'probeIp unavailable' } };
    }
    try {
      return { status: 200, body: await scanner.probeIp(ip) };
    } catch (e) {
      return { status: 500, body: { ok: false, error: e.message || 'probe failed' } };
    }
  }
  return { status: 404, body: { error: 'Unknown scan path' } };
}

async function handleMaintenanceLogs(method, pathname, query, body) {
  let printerLogsMod;
  try {
    printerLogsMod = require(path.join(SERVER_ROOT, 'printer-logs.js'));
  } catch (e) {
    try {
      printerLogsMod = require('./lib/server/printer-logs.js');
    } catch (e2) {
      return { status: 500, body: { error: 'printer-logs module not found: ' + e2.message } };
    }
  }

  // Find printers
  let availablePrinters = [];
  try {
    const poolMod = require(path.join(SERVER_ROOT, 'pool.js'));
    availablePrinters = poolMod.listFull();
  } catch {}

  // If pool empty, try runtime file
  if (!availablePrinters || !availablePrinters.length) {
    const candidates = [
      path.join(SERVER_ROOT, 'config.runtime.json'),
      path.join(__dirname, '..', 'src', 'server', 'config.runtime.json'),
      path.join(defaultDataDir(), 'config.runtime.json'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        try {
          const raw = JSON.parse(fs.readFileSync(c, 'utf8'));
          if (Array.isArray(raw.printers) && raw.printers.length > 0) {
            availablePrinters = raw.printers;
            break;
          }
        } catch {}
      }
    }
  }

  // If still empty, try farm-bff
  if (!availablePrinters || !availablePrinters.length) {
    try {
      const bff = farmBffUrl();
      assertLocalBff(bff);
      const bffRes = await httpJson('GET', `${bff}/api/printers`, { timeoutMs: 10000 });
      if (bffRes.status === 200 && bffRes.body && Array.isArray(bffRes.body.printers)) {
        availablePrinters = bffRes.body.printers;
      }
    } catch {}
  }

  // Enrich Bambu access codes if missing
  try {
    const accessCandidates = farmBffDirCandidates().map((d) => path.join(d, 'data', 'bambu-access-codes.json'));
    for (const ap of accessCandidates) {
      if (fs.existsSync(ap)) {
        const codes = JSON.parse(fs.readFileSync(ap, 'utf8'));
        for (const p of availablePrinters) {
          if (!p.access_code && p.serial && codes[p.serial]) p.access_code = codes[p.serial];
          if (!p.access_code && p.id && codes[p.id]) p.access_code = codes[p.id];
        }
        break;
      }
    }
  } catch {}

  const payload = body || query || {};
  const { target, printerId, printerIds, group, mode } = payload;

  // Live states from farm-bff if available
  let printerStates = {};
  try {
    const bff = farmBffUrl();
    assertLocalBff(bff);
    const bffBoard = await httpJson('GET', `${bff}/api/board`, { timeoutMs: 15000 });
    if (bffBoard.body && (bffBoard.body.printers || bffBoard.body.tiles)) {
      const list = bffBoard.body.printers || bffBoard.body.tiles;
      for (const p of list) {
        printerStates[p.id] = p;
      }
    }
  } catch {}

  try {
    const resArchive = await printerLogsMod.collectAndBuildArchive({
      printers: availablePrinters,
      printerStates,
      target: target || (printerIds ? 'multiple' : (printerId ? 'single' : 'group')),
      printerId,
      printerIds,
      group: group || 'all',
      mode: mode || 'dump',
    });

    if (pathname.endsWith('/collect')) {
      return { status: 200, body: { ok: true, manifest: resArchive.manifest } };
    }

    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
    let targetSuffix = '_all';
    if (target === 'single') {
      targetSuffix = `_${String(printerId).replace(/[^a-zA-Z0-9_\-]/g, '_')}`;
    } else if (target === 'multiple' || (Array.isArray(printerIds) && printerIds.length > 0)) {
      targetSuffix = `_selected-${printerIds ? printerIds.length : 'items'}`;
    } else {
      targetSuffix = `_${group || 'all'}`;
    }
    const filename = `farm-logs_${dateStr}${targetSuffix}.zip`;

    return {
      status: 200,
      binaryBase64: resArchive.zipBuffer.toString('base64'),
      contentType: 'application/zip',
      headers: {
        'content-disposition': `attachment; filename="${filename}"`,
      },
    };
  } catch (err) {
    return { status: 400, body: { ok: false, error: err.message } };
  }
}

async function handleRpc(msg) {
  const method = String(msg.method || 'GET').toUpperCase();
  const pathname = String(msg.path || '');
  const query = msg.query || {};
  const body = msg.body;
  const bodyBinaryBase64 = msg.bodyBinaryBase64;
  const reqContentType =
    msg.contentType ||
    (msg.headers && (msg.headers['content-type'] || msg.headers['Content-Type'])) ||
    null;

  // Сквозной request-id: браузер → SaaS → Edge → bff; bff пишет его в журнал попыток.
  const requestId = requestIdFromMsg(msg);
  const headers = requestId ? { 'X-Request-Id': requestId } : undefined;
  const qs = new URLSearchParams(query).toString();

  if (!isAllowedPath(pathname)) {
    return { status: 403, body: { error: 'Path not allowlisted on edge', code: 'EDGE_DENY' } };
  }

  if (pathname.startsWith('/api/maintenance/logs')) {
    return handleMaintenanceLogs(method, pathname, query, body);
  }

  if (pathname.startsWith('/api/warehouse')) {
    return handleWarehouse(method, pathname, query, body, bodyBinaryBase64);
  }

  if (pathname === '/api/network' || pathname.startsWith('/api/scan')) {
    if (pathname === '/api/scan/add' && method === 'POST') {
      const device = body && body.device;
      if (!device) return { status: 400, body: { error: 'device обязателен' } };

      const overrides = (body && body.overrides) || device.config || {};
      const devIp = device.ip || overrides.ip || device.config?.ip;
      const devType = device.type === 'creality-box' ? 'klipper' : (device.type || overrides.type || 'unknown');
      const devName = overrides.name || device.name || device.config?.name || `Printer ${devIp}`;
      const devId = overrides.id || device.config?.id || `${devType}-${String(devIp || '').replace(/\./g, '-')}`;

      // 1. Попытка добавить через farm-bff, если он запущен локально (для цеха 3D Zipper)
      try {
        const bff = farmBffUrl();
        assertLocalBff(bff);
        const r = await httpJson('POST', `${bff}/api/printers/adopt`, {
          body: {
            host: {
              ip: devIp,
              type: devType,
              name: devName,
            },
            overrides,
          },
          timeoutMs: 2000,
        });
        if (r && r.status < 400) {
          return r;
        }
      } catch (bffErr) {
        // farm-bff отсутствует на 127.0.0.1:3001 — норма для внешнего клиента Farm Edge
      }

      // 2. Автономный режим Edge: сохраняем принтер локально в printers.json агента
      const brand = overrides.brand || device.brand || (devType === 'elegoo' ? 'Elegoo' : devType === 'bambu' ? 'Bambu Lab' : devType);
      const model = overrides.model || device.model || (devType === 'elegoo' ? 'Centauri Carbon' : devName);

      const printerObj = {
        id: devId,
        name: devName,
        ip: devIp,
        ip_address: devIp,
        type: devType,
        brand,
        model,
        material: overrides.material || 'PLA',
        status: 'idle',
        print_status: 'idle',
        online: true,
        is_online: true,
        source: 'edge-local',
        config: { ...device.config, ...overrides, ip: devIp, name: devName, id: devId },
        addedAt: new Date().toISOString(),
      };

      saveLocalEdgePrinter(printerObj);
      return { status: 200, body: { ok: true, printer: printerObj } };
    }
    return handleScan(method, pathname, query, body);
  }

  // Удаление принтера: удаляем из локального файла и пробуем bff
  const delPrinterMatch = pathname.match(/^\/api\/printers\/([^/]+)$/);
  if (delPrinterMatch && method === 'DELETE') {
    const pid = decodeURIComponent(delPrinterMatch[1]);
    try {
      const p = localPrintersPath();
      let list = loadLocalEdgePrinters();
      list = list.filter(x => x.id !== pid);
      fs.writeFileSync(p, JSON.stringify(list, null, 2), 'utf8');
    } catch {}
    try {
      const bff = farmBffUrl();
      assertLocalBff(bff);
      await httpJson('DELETE', `${bff}/api/printers/${encodeURIComponent(pid)}`, { timeoutMs: 2000, headers });
    } catch {}
    return { status: 200, body: { ok: true } };
  }

  // Printers + board + otm
  const bff = farmBffUrl();

  if (pathname === '/api/printers' && method === 'GET') {
    try {
      assertLocalBff(bff);
      // Prefer warm cache from BFF background poll. If empty/stale → one live poll.
      let board = await httpJson('GET', `${bff}/api/board`, { timeoutMs: 3000 });
      if (board.status < 400 && board.body) {
        const rows = (board.body && (board.body.printers || board.body.tiles)) || [];
        if (rows.length > 0) {
          const printers = mapBoardToPrinters(board.body || {});
          return { status: 200, body: printers };
        }
      }
    } catch (e) {
      /* farm-bff на 3001 не отвечает — переходим к локальному пулу */
    }

    // fallback: если farm-bff нет или пуст, отдаём локально сохранённые принтеры
    const localList = loadLocalEdgePrinters();
    return { status: 200, body: localList };
  }

  assertLocalBff(bff);

  // SaaS dashboard starts print via POST /api/printers/:id/print-file; farm-bff expects POST /api/upload/printers/:id/start
  const printFileMatch = pathname.match(/^\/api\/printers\/([^/]+)\/print-file$/);
  if (printFileMatch && method === 'POST') {
    const pid = decodeURIComponent(printFileMatch[1]);
    const fname = body?.filename || body?.file || body?.remoteName;
    if (!fname) return { status: 400, body: { error: 'filename обязателен', code: 'NO_FILENAME' } };
    return httpJson('POST', `${bff}/api/upload/printers/${encodeURIComponent(pid)}/start`, {
      body: { filename: fname, remoteName: fname, useAms: body?.useAms, plateNumber: body?.plateNumber },
      timeoutMs: 30000,
      headers,
    });
  }

  // Files on printer: farm-bff first; if it is down or returns nothing, ask Moonraker directly
  const filesMatch = pathname.match(/^\/api\/printers\/([^/]+)\/files$/);
  if (filesMatch && method === 'GET') {
    const pid = decodeURIComponent(filesMatch[1]);
    let bffRes = null;
    try {
      bffRes = await httpJson('GET', `${bff}${pathname}${qs ? `?${qs}` : ''}`, { timeoutMs: 8000, headers });
      if (bffRes.status === 200 && Array.isArray(bffRes.body?.files) && bffRes.body.files.length > 0) {
        return bffRes;
      }
    } catch (_) {}

    const targetIp = moonrakerIpFor(pid);
    if (targetIp) {
      try {
        const mrRes = await httpJson('GET', `http://${targetIp}:7125/server/files/list?root=gcodes`, {
          timeoutMs: 10000,
          noAuth: true,
        });
        if (mrRes.status === 200 && Array.isArray(mrRes.body?.result)) {
          const files = mrRes.body.result
            .map((f) => ({
              name: (f.path || '').split('/').pop(),
              path: f.path,
              size: f.size,
              modified: f.modified,
              printable: true,
            }))
            .sort((a, b) => (Number(b.modified) || 0) - (Number(a.modified) || 0));
          return { status: 200, body: { ok: true, printerId: pid, source: 'moonraker-direct', files } };
        }
      } catch (_) {}
    }
    if (bffRes) return bffRes;
  }

  // SaaS dashboard asks /api/printers/:id/snapshot; farm-bff serves camera frames at
  // /api/printers/:id/camera/snapshot (Bambu :6000/:322, MJPEG http, Elegoo SDCP).
  let bffPath = pathname;
  const snapAlias = pathname.match(/^\/api\/printers\/([^/]+)\/snapshot$/);
  if (snapAlias && method === 'GET') bffPath = `/api/printers/${snapAlias[1]}/camera/snapshot`;

  // Passthrough allowlisted farm-bff ops paths
  const url = `${bff}${bffPath}${qs ? `?${qs}` : ''}`;
  const timeoutMs = bffTimeoutFor(pathname, method);
  const t0 = Date.now();
  const logOutcome = (r, err) => {
    // Только ошибки и загрузки — чтобы лог агента у клиента оставался читаемым.
    const isUpload = pathname.startsWith('/api/upload/') && method !== 'GET';
    if (err) {
      console.warn(new Date().toISOString(), '[farm-edge] rpc', method, pathname, requestId || '-', 'ERR', err.code || '', err.message || err, `${Date.now() - t0}ms`);
    } else if (isUpload || (r && r.status >= 400)) {
      console.log(new Date().toISOString(), '[farm-edge] rpc', method, pathname, requestId || '-', 'HTTP', r.status, `${Date.now() - t0}ms`);
    }
  };
  const run = bodyBinaryBase64
    ? httpJson(method, url, {
        binary: Buffer.from(bodyBinaryBase64, 'base64'),
        timeoutMs,
        contentType: reqContentType || undefined,
        headers,
      })
    : httpJson(method, url, {
        body: method === 'GET' || method === 'HEAD' ? undefined : body,
        timeoutMs,
        headers,
      });
  return run.then(
    (r) => { logOutcome(r); return r; },
    (err) => { logOutcome(null, err); throw err; }
  );
}

module.exports = {
  handleRpc,
  lanHint,
  isAllowedPath,
  isPrivateIpv4,
  assertLocalBff,
  requestIdFromMsg,
  mapBoardToPrinters,
  mapPlateToStatus,
  bffTimeoutFor,
  moonrakerIpFor,
};
