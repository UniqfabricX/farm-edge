'use strict';

/**
 * OTM bridge for farm-control-saas — write collect / scrap / stock into progress.json
 * (same semantics as farm-bff/otm-progress.js) + local journal.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');

const SCRAP_REASONS = {
  layer_shift: 'Смещение слоёв',
  filament_jam: 'Застревание филамента',
  printer_error: 'Ошибка принтера',
  bad_adhesion: 'Плохая адгезия',
  other: 'Другое',
};

function scrapReasonLabel(code) {
  return SCRAP_REASONS[code] || code || 'Другое';
}

function defaultOtmDir() {
  const candidates = [
    process.env.OTM_INVENTORY_DIR,
    path.join('C:', 'FARM', 'OTM'),
    path.join('C:', 'Users', 'User', 'OTM'),
    path.join('C:', 'Users', 'user', 'OTM'),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(path.join(p, 'progress.json')) || fs.existsSync(p)) return p;
    } catch {}
  }
  return candidates[0] || path.join('C:', 'FARM', 'OTM');
}

function progressPath() {
  return path.join(defaultOtmDir(), 'progress.json');
}

function journalPath() {
  return path.join(defaultOtmDir(), 'collect-journal.jsonl');
}

function partIdFromKey(key) {
  const s = String(key || '').trim();
  if (!s) return '';
  if (s === 'plug-20x20' || s === 'Заглушка 20х20') return 'plug-20x20';
  const i = s.indexOf(':');
  return i >= 0 ? s.slice(i + 1) : s;
}

function qtyFromTables(wip) {
  if (!Array.isArray(wip)) return 0;
  return wip.reduce((s, pair) => s + (Number(pair?.[0]) || 0) * (Number(pair?.[1]) || 0), 0);
}

function loadProgressStore() {
  const p = progressPath();
  const otm = defaultOtmDir();
  fs.mkdirSync(otm, { recursive: true });
  if (!fs.existsSync(p)) {
    const empty = { parts: {}, plates: {} };
    fs.writeFileSync(p, JSON.stringify(empty, null, 2), 'utf8');
    return empty;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      parts: raw.parts && typeof raw.parts === 'object' ? raw.parts : {},
      plates: raw.plates && typeof raw.plates === 'object' ? raw.plates : {},
    };
  } catch (e) {
    throw new Error('Не удалось прочитать progress.json: ' + e.message);
  }
}

function saveProgressStore(parts, plates) {
  const p = progressPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const payload = { parts, plates, updatedAt: new Date().toISOString() };
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

function progressEntry(pid, parts) {
  const cur = parts[pid] || {};
  return {
    stock: Number(cur.stock || 0),
    wip: Array.isArray(cur.wip) ? cur.wip : [],
    wip_qty: cur.wip_qty != null ? Number(cur.wip_qty) : undefined,
    plan: Array.isArray(cur.plan) ? cur.plan : [],
    scrap_total: Number(cur.scrap_total || 0),
    scrap_log: Array.isArray(cur.scrap_log) ? cur.scrap_log : [],
    done_qty: Number(cur.done_qty || 0),
    done: Array.isArray(cur.done) ? cur.done : [],
  };
}

function deductPlanPieces(plan, pieces) {
  let deduct = Math.max(0, Math.floor(Number(pieces) || 0));
  const platesArr = [];
  for (const pair of plan || []) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const n = Number(pair[0]) || 0;
    const pp = Number(pair[1]) || 0;
    for (let i = 0; i < n; i += 1) platesArr.push(pp);
  }
  if (deduct <= 0) {
    return (plan || []).map((pair) => [Number(pair[0]) || 0, Number(pair[1]) || 0]);
  }
  const keep = Math.max(0, platesArr.reduce((s, pp) => s + pp, 0) - deduct);
  const trimmed = [];
  let acc = 0;
  for (const pp of platesArr) {
    if (acc >= keep) break;
    const take = Math.min(pp, keep - acc);
    if (take > 0) {
      trimmed.push(take);
      acc += take;
    }
  }
  const merged = [];
  for (const pp of trimmed) {
    if (merged.length && merged[merged.length - 1][1] === pp) merged[merged.length - 1][0] += 1;
    else merged.push([1, pp]);
  }
  return merged;
}

function snapshot(pid, parts, plates) {
  const cur = progressEntry(pid, parts);
  const wip = cur.wip_qty != null ? Number(cur.wip_qty) : qtyFromTables(cur.wip);
  const planQty = Array.isArray(cur.plan)
    ? cur.plan.reduce((s, x) => s + (Number(x?.[0]) || 0) * (Number(x?.[1]) || 0), 0)
    : 0;
  const stock = Number(cur.stock || 0);
  return {
    partId: pid,
    stock,
    wip,
    planQty,
    scrapTotal: Number(cur.scrap_total || 0),
    plateQty: plates[pid] != null ? Number(plates[pid]) : null,
    needProduce: Math.max(0, planQty - wip),
    readyToCollect: wip,
  };
}

function appendJournal(entry) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const row = {
    id: `cj-${crypto.randomBytes(5).toString('hex')}`,
    at: now.toISOString(),
    date,
    time,
    ...entry,
  };
  const jp = journalPath();
  fs.mkdirSync(path.dirname(jp), { recursive: true });
  fs.appendFileSync(jp, JSON.stringify(row) + '\n', 'utf8');
  return row;
}

function listJournal({ limit = 80, today = false, date = null } = {}) {
  const jp = journalPath();
  if (!fs.existsSync(jp)) return { ok: true, items: [], count: 0 };
  const lines = fs.readFileSync(jp, 'utf8').split('\n').filter(Boolean);
  let items = [];
  for (let i = lines.length - 1; i >= 0 && items.length < 500; i--) {
    try { items.push(JSON.parse(lines[i])); } catch {}
  }
  if (today || date) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const d = date || `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    items = items.filter((x) => x.date === d);
  }
  const lim = Math.max(1, Math.min(200, Number(limit) || 80));
  items = items.slice(0, lim);
  return { ok: true, items, count: items.length };
}

function resolveQty(body, plateQty) {
  const pieces = body.pieces != null ? Number(body.pieces) : null;
  const tables = body.tables != null ? Number(body.tables) : null;
  if (pieces != null && pieces > 0) {
    return { qty: Math.floor(pieces), tables: null, note: `${Math.floor(pieces)} шт` };
  }
  if (tables != null && tables > 0) {
    const pp = Number(plateQty) || 0;
    if (pp <= 0) throw new Error('Сначала задайте шт/стол (plateQty)');
    const qty = Math.floor(tables) * pp;
    return { qty, tables: Math.floor(tables), note: `${Math.floor(tables)} ст × ${pp} = ${qty} шт` };
  }
  throw new Error('Укажите штуки или столы');
}

function writeCollectFull({ key, qty, perPlate = null }) {
  const pid = partIdFromKey(key);
  if (!pid) throw new Error('partId / key обязателен');
  const amount = Math.floor(Number(qty) || 0);
  if (amount <= 0) throw new Error('qty must be positive');

  const { parts, plates } = loadProgressStore();
  const cur = progressEntry(pid, parts);
  const stockBefore = Number(cur.stock || 0);
  const entry = { ...cur };
  entry.stock = stockBefore + amount;
  entry.done_qty = 0;
  entry.done = [];
  entry.plan = deductPlanPieces(cur.plan || [], amount);
  if (cur.wip_qty != null) {
    entry.wip_qty = Math.max(0, Number(cur.wip_qty) - amount);
  } else if (cur.wip && cur.wip.length) {
    const rem = Math.max(0, qtyFromTables(cur.wip) - amount);
    entry.wip = rem > 0 ? [[1, rem]] : [];
  }
  parts[pid] = entry;
  if (perPlate != null && perPlate > 0) plates[pid] = Math.floor(perPlate);
  saveProgressStore(parts, plates);
  return { stockBefore, ...snapshot(pid, parts, plates) };
}

function writeScrapUpdate({ key, qty, reason, perPlate = null }) {
  const pid = partIdFromKey(key);
  if (!pid) throw new Error('partId / key обязателен');
  const amount = Math.floor(Number(qty) || 0);
  if (amount <= 0) throw new Error('qty must be positive');

  const { parts, plates } = loadProgressStore();
  const cur = progressEntry(pid, parts);
  const entry = { ...cur };
  entry.scrap_total = Number(cur.scrap_total || 0) + amount;
  if (cur.wip_qty != null) {
    entry.wip_qty = Math.max(0, Number(cur.wip_qty) - amount);
  } else if (cur.wip && cur.wip.length) {
    const rem = Math.max(0, qtyFromTables(cur.wip) - amount);
    entry.wip = rem > 0 ? [[1, rem]] : [];
  }
  const log = Array.isArray(cur.scrap_log) ? [...cur.scrap_log] : [];
  log.push({ qty: amount, reason: String(reason || 'other'), at: new Date().toISOString() });
  entry.scrap_log = log.slice(-50);
  parts[pid] = entry;
  if (perPlate != null && perPlate > 0) plates[pid] = Math.floor(perPlate);
  saveProgressStore(parts, plates);
  return snapshot(pid, parts, plates);
}

function writeProgressUpdate({ key, stockAdd = 0, stockSet = null, wipQty = null, perPlate = null, planAddTables = null }) {
  const pid = partIdFromKey(key);
  if (!pid) throw new Error('partId / key обязателен');
  const { parts, plates } = loadProgressStore();
  const cur = progressEntry(pid, parts);

  const add = Math.max(0, Math.floor(Number(stockAdd) || 0));
  let newStock;
  if (stockSet != null && Number.isFinite(Number(stockSet))) {
    newStock = Math.max(0, Math.floor(Number(stockSet)));
  } else {
    newStock = Math.max(0, Number(cur.stock || 0) + add);
  }

  const entry = {
    ...cur,
    stock: newStock,
    done_qty: 0,
    done: [],
    plan: Array.isArray(cur.plan) ? [...cur.plan] : [],
  };

  if (wipQty != null && Number.isFinite(Number(wipQty))) {
    entry.wip_qty = Math.max(0, Math.floor(Number(wipQty)));
    entry.wip = [];
  }

  if (planAddTables != null && Number(planAddTables) > 0) {
    const pp = perPlate != null && perPlate > 0
      ? Math.floor(perPlate)
      : (plates[pid] != null ? Number(plates[pid]) : 0);
    if (pp <= 0) throw new Error('Для плана нужен шт/стол');
    entry.plan.push([Math.floor(Number(planAddTables)), pp]);
  }

  parts[pid] = entry;
  if (perPlate != null && perPlate > 0) plates[pid] = Math.floor(perPlate);
  saveProgressStore(parts, plates);
  return snapshot(pid, parts, plates);
}

function farmBffBases() {
  return [
    process.env.FARM_BFF_URL,
    'http://127.0.0.1:3001',
    'http://127.0.0.1:8080',
  ].filter(Boolean);
}

function httpPostJson(url, body, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        Accept: 'application/json',
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = {};
        try { json = raw ? JSON.parse(raw) : {}; } catch { json = { raw }; }
        if (res.statusCode >= 400) {
          const err = new Error(json.error || (`HTTP ${res.statusCode}`));
          err.status = res.statusCode;
          err.body = json;
          return reject(err);
        }
        resolve(json);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

async function tryFarmBff(pathname, body) {
  for (const base of farmBffBases()) {
    try {
      const json = await httpPostJson(base.replace(/\/$/, '') + pathname, body);
      if (json && json.ok) return { via: base, ...json };
    } catch {
      // next
    }
  }
  return null;
}

function freshSnap(pid) {
  const { parts, plates } = loadProgressStore();
  return snapshot(pid, parts, plates);
}

async function applyCollect(body) {
  const key = String(body.partId || body.key || '').trim();
  if (!key) throw new Error('partId обязателен');
  const { plates } = loadProgressStore();
  const pid = partIdFromKey(key);
  const plate = plates[pid] != null ? Number(plates[pid]) : (body.plateQty != null ? Number(body.plateQty) : null);
  const { qty, tables, note } = resolveQty(body, plate);

  const viaBff = await tryFarmBff('/api/otm/collect', {
    key: pid,
    pieces: tables == null ? qty : undefined,
    tables: tables != null ? tables : undefined,
    partName: body.partName || '',
    source: body.source || 'control-saas',
  });
  if (viaBff) {
    appendJournal({
      partId: pid,
      partName: body.partName || '',
      pieces: qty,
      tables,
      perPlate: plate,
      stock: viaBff.stockAfter != null ? viaBff.stockAfter : null,
      collectKind: 'printer-collect',
      note: note + ' · via farm-bff',
      source: 'control-saas',
    });
    return {
      ok: true,
      via: 'farm-bff',
      collected: qty,
      message: viaBff.message || `Принято: +${qty} шт`,
      stock: freshSnap(pid),
      bff: viaBff,
    };
  }

  const result = writeCollectFull({ key: pid, qty, perPlate: plate });
  appendJournal({
    partId: pid,
    partName: body.partName || '',
    pieces: qty,
    tables,
    perPlate: plate,
    stock: result.stock,
    collectKind: 'printer-collect',
    note,
    source: body.source || 'control-saas',
  });
  return {
    ok: true,
    via: 'local-progress',
    collected: qty,
    message: `Принято: +${qty} шт на склад (${result.stockBefore} → ${result.stock})`,
    stock: result,
  };
}

async function applyScrap(body) {
  const key = String(body.partId || body.key || '').trim();
  if (!key) throw new Error('partId обязателен');
  const reason = String(body.reason || '').trim() || 'other';
  if (!SCRAP_REASONS[reason]) throw new Error('Выберите причину брака');

  const { plates } = loadProgressStore();
  const pid = partIdFromKey(key);
  const plate = plates[pid] != null ? Number(plates[pid]) : (body.plateQty != null ? Number(body.plateQty) : null);
  const { qty, tables, note } = resolveQty(body, plate);

  const viaBff = await tryFarmBff('/api/otm/scrap', {
    key: pid,
    reason,
    pieces: tables == null ? qty : undefined,
    tables: tables != null ? tables : undefined,
    partName: body.partName || '',
    source: body.source || 'control-saas',
  });
  if (viaBff) {
    appendJournal({
      partId: pid,
      partName: body.partName || '',
      pieces: qty,
      tables,
      perPlate: plate,
      collectKind: 'printer-scrap',
      note: `брак ${note} · ${scrapReasonLabel(reason)} · via farm-bff`,
      source: 'control-saas',
    });
    return {
      ok: true,
      via: 'farm-bff',
      scrapped: qty,
      reason: scrapReasonLabel(reason),
      message: viaBff.message || `Брак: ${qty} шт`,
      stock: freshSnap(pid),
      bff: viaBff,
    };
  }

  const result = writeScrapUpdate({ key: pid, qty, reason, perPlate: plate });
  appendJournal({
    partId: pid,
    partName: body.partName || '',
    pieces: qty,
    tables,
    perPlate: plate,
    collectKind: 'printer-scrap',
    note: `брак ${note} · ${scrapReasonLabel(reason)}`,
    source: body.source || 'control-saas',
  });
  return {
    ok: true,
    via: 'local-progress',
    scrapped: qty,
    reason: scrapReasonLabel(reason),
    message: `Брак: ${qty} шт (${scrapReasonLabel(reason)})`,
    stock: result,
  };
}

async function applyStockSettings(body) {
  const key = String(body.partId || body.key || '').trim();
  if (!key) throw new Error('partId обязателен');
  const pid = partIdFromKey(key);
  const stockSet = body.stockSet != null ? Number(body.stockSet) : null;
  const perPlate = body.perPlate != null ? Number(body.perPlate) : null;
  let wipQty = body.wipQty != null ? Number(body.wipQty) : null;
  if (wipQty == null && body.wipTables != null && perPlate > 0) {
    wipQty = Number(body.wipTables) * Number(perPlate);
  }
  const planAddTables = body.planAddTables != null ? Number(body.planAddTables) : null;

  const hasStock = stockSet != null && Number.isFinite(stockSet) && stockSet >= 0;
  const hasWip = wipQty != null;
  const hasPlate = perPlate != null && perPlate > 0;
  const hasPlan = planAddTables != null && planAddTables > 0;
  if (!hasStock && !hasWip && !hasPlate && !hasPlan) {
    throw new Error('Укажите склад, печать, шт/стол или план');
  }

  if ((hasStock || hasWip || hasPlate) && !hasPlan) {
    const viaBff = await tryFarmBff('/api/otm/warehouse', {
      key: pid,
      stockSet: hasStock ? stockSet : undefined,
      perPlate: hasPlate ? perPlate : undefined,
      wipQty: hasWip ? wipQty : undefined,
      partName: body.partName || '',
      source: body.source || 'control-saas',
    });
    if (viaBff) {
      appendJournal({
        partId: pid,
        partName: body.partName || '',
        collectKind: 'warehouse-settings',
        note: viaBff.message || 'настройки склада',
        source: 'control-saas',
        stock: viaBff.stockAfter != null ? viaBff.stockAfter : null,
      });
      return {
        ok: true,
        via: 'farm-bff',
        message: viaBff.message || 'Сохранено',
        stock: freshSnap(pid),
        bff: viaBff,
      };
    }
  }

  const before = freshSnap(pid);
  const result = writeProgressUpdate({
    key: pid,
    stockSet: hasStock ? stockSet : null,
    wipQty: hasWip ? Math.max(0, Math.floor(wipQty)) : null,
    perPlate: hasPlate ? perPlate : null,
    planAddTables: hasPlan ? planAddTables : null,
  });
  const notes = [];
  if (hasStock) notes.push(`склад ${before.stock} → ${result.stock}`);
  if (hasWip) notes.push(`печать ${result.wip} шт`);
  if (hasPlate) notes.push(`шт/стол ${result.plateQty}`);
  if (hasPlan) notes.push(`план +${planAddTables} ст`);
  appendJournal({
    partId: pid,
    partName: body.partName || '',
    collectKind: 'warehouse-settings',
    note: notes.join(' · '),
    source: 'control-saas',
    stock: result.stock,
  });
  return { ok: true, via: 'local-progress', message: notes.join(' · ') || 'Сохранено', stock: result };
}

function getStockSnapshot(partId) {
  return freshSnap(partIdFromKey(partId));
}

module.exports = {
  SCRAP_REASONS,
  scrapReasonLabel,
  defaultOtmDir,
  loadProgressStore,
  getStockSnapshot,
  applyCollect,
  applyScrap,
  applyStockSettings,
  listJournal,
  writeCollectFull,
  writeScrapUpdate,
  writeProgressUpdate,
};
