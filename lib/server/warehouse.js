'use strict';

/**
 * Warehouse (Склад) for farm-control-saas
 * - Parts catalog (JSON under DATA_DIR/warehouse/parts)
 * - CAD (stl/step) + images on disk
 * - G-code profile links
 * - Print plan items → SaaS queue
 * - Live stock from OTM progress.json (read-only bridge)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const otmBridge = require('./otm-bridge');

const DATA_DIR = process.env.FARM_DATA_DIR
  || (fs.existsSync('/app/data') ? '/app/data' : path.join(__dirname, '..', '..', 'data'));

const WH_ROOT = path.join(DATA_DIR, 'warehouse');
const PARTS_DIR = path.join(WH_ROOT, 'parts');
const CAD_DIR = path.join(WH_ROOT, 'cad');
const IMAGES_DIR = path.join(WH_ROOT, 'images');
const GCODE_DIR = path.join(WH_ROOT, 'gcode');
const PLAN_PATH = path.join(WH_ROOT, 'plan.json');
const PROFILES_PATH = path.join(WH_ROOT, 'gcode-profiles.json');

function defaultFarmBffParts() {
  const candidates = [
    process.env.FARM_BFF_PARTS_DIR,
    path.join('C:', 'FARM', 'farm-bff', 'data', 'parts'),
    path.resolve(__dirname, '..', '..', '..', 'farm-bff', 'data', 'parts'),
    path.resolve(__dirname, '..', '..', '..', '..', 'farm-bff', 'data', 'parts'),
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

function defaultOtmDir() {
  const candidates = [
    process.env.OTM_INVENTORY_DIR,
    path.join('C:', 'Users', 'User', 'OTM'),
    path.join('C:', 'Users', 'user', 'OTM'),
    path.join('C:', 'FARM', 'OTM'),
    path.resolve(__dirname, '..', '..', '..', '..', 'OTM'),
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.existsSync(path.join(p, 'progress.json')) || fs.existsSync(p)) return p; } catch {}
  }
  return candidates[0] || path.join(DATA_DIR, 'otm');
}

function ensureDirs() {
  for (const d of [WH_ROOT, PARTS_DIR, CAD_DIR, IMAGES_DIR, GCODE_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
  if (!fs.existsSync(PLAN_PATH)) fs.writeFileSync(PLAN_PATH, JSON.stringify({ items: [] }, null, 2));
  if (!fs.existsSync(PROFILES_PATH)) fs.writeFileSync(PROFILES_PATH, JSON.stringify({ profiles: [] }, null, 2));
}

function safeKey(id) {
  return String(id || '').replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_') || 'unknown';
}

function partFile(partId) {
  return path.join(PARTS_DIR, `${safeKey(partId)}.json`);
}

function loadPart(partId) {
  const p = partFile(partId);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function savePart(part) {
  ensureDirs();
  part.updatedAt = new Date().toISOString();
  if (!part.createdAt) part.createdAt = part.updatedAt;
  fs.writeFileSync(partFile(part.partId), JSON.stringify(part, null, 2), 'utf8');
  return part;
}

function listPartsMeta() {
  ensureDirs();
  if (!fs.existsSync(PARTS_DIR)) return [];
  return fs.readdirSync(PARTS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(PARTS_DIR, f), 'utf8')); }
      catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => String(a.partId).localeCompare(String(b.partId)));
}

function loadProgress() {
  const otm = defaultOtmDir();
  const prog = path.join(otm, 'progress.json');
  try {
    if (!fs.existsSync(prog)) return { parts: {}, plates: {}, otmDir: otm, ok: false };
    const data = JSON.parse(fs.readFileSync(prog, 'utf8'));
    return {
      parts: data.parts && typeof data.parts === 'object' ? data.parts : {},
      plates: data.plates && typeof data.plates === 'object' ? data.plates : {},
      otmDir: otm,
      ok: true,
    };
  } catch (e) {
    return { parts: {}, plates: {}, otmDir: otm, ok: false, error: e.message };
  }
}

function stockFor(partId, progress) {
  const row = (progress.parts || {})[partId] || {};
  const plate = (progress.plates || {})[partId];
  return {
    stock: Number(row.stock || 0),
    wip: Number(row.wip_qty != null ? row.wip_qty : (Array.isArray(row.wip) ? row.wip.reduce((s, x) => s + (Number(x?.[0]) || 0) * (Number(x?.[1]) || 0), 0) : 0)),
    plan: Array.isArray(row.plan) ? row.plan.reduce((s, x) => s + (Number(x?.[0]) || 0) * (Number(x?.[1]) || 0), 0) : Number(row.plan || 0),
    done: Number(row.done_qty || 0),
    scrap: Number(row.scrap_total || 0),
    plateQty: plate != null ? Number(plate) : null,
  };
}

function enrichPart(part, progress) {
  if (!part) return null;
  const stock = stockFor(part.partId, progress || loadProgress());
  const planQty = stock.plan;
  const wip = stock.wip;
  return {
    ...part,
    stock: stock.stock,
    wip,
    planQty,
    done: stock.done,
    scrap: stock.scrap,
    plateQty: stock.plateQty ?? part.plateQty ?? null,
    needProduce: Math.max(0, planQty - wip),
    readyToCollect: wip,
    hasImage: !!(part.imagePath && fs.existsSync(part.imagePath)),
    cadCount: Array.isArray(part.cadFiles) ? part.cadFiles.length : 0,
    gcodeCount: Array.isArray(part.gcodeProfileIds) ? part.gcodeProfileIds.length : 0,
  };
}

function listWarehouse(query = {}) {
  const progress = loadProgress();
  let parts = listPartsMeta().map(p => enrichPart(p, progress));
  const q = String(query.q || '').trim().toLowerCase();
  if (q) {
    parts = parts.filter(p =>
      String(p.partId).toLowerCase().includes(q) ||
      String(p.name || '').toLowerCase().includes(q) ||
      String(p.material || '').toLowerCase().includes(q)
    );
  }
  if (query.material) {
    const m = String(query.material).toUpperCase();
    parts = parts.filter(p => String(p.material || '').toUpperCase().includes(m));
  }
  if (query.stock === 'low') parts = parts.filter(p => (p.stock || 0) <= 0);
  if (query.stock === 'ok') parts = parts.filter(p => (p.stock || 0) > 0);
  return {
    ok: true,
    otm: { dir: progress.otmDir, connected: !!progress.ok, error: progress.error || null },
    count: parts.length,
    parts,
  };
}

function getPartCard(partId) {
  const part = loadPart(partId);
  if (!part) return null;
  const progress = loadProgress();
  const profiles = listProfiles().filter(pr =>
    pr.partId === part.partId || (part.gcodeProfileIds || []).includes(pr.id)
  );
  return { ok: true, part: enrichPart(part, progress), profiles };
}

function upsertPart({ partId, name, material, notes, plateQty }) {
  const id = String(partId || '').trim();
  if (!id) throw new Error('partId обязателен');
  let part = loadPart(id);
  const now = new Date().toISOString();
  if (!part) {
    part = {
      id: `part-${crypto.randomBytes(6).toString('hex')}`,
      partId: id,
      name: name || id,
      material: material || 'PETG',
      notes: notes || '',
      imagePath: '',
      imageSource: '',
      cadFiles: [],
      gcodeProfileIds: [],
      plateQty: plateQty != null ? Number(plateQty) : null,
      createdAt: now,
      sources: ['saas'],
    };
  } else {
    if (name != null) part.name = name;
    if (material != null) part.material = material;
    if (notes != null) part.notes = notes;
    if (plateQty != null) part.plateQty = Number(plateQty);
  }
  return savePart(part);
}

function saveCadBuffer(partId, { kind, fileName, buffer }) {
  const part = loadPart(partId) || upsertPart({ partId });
  const k = String(kind || '').toLowerCase();
  if (!['stl', 'step', 'stp'].includes(k)) throw new Error('kind: stl|step');
  const kindNorm = k === 'stp' ? 'step' : k;
  const dir = path.join(CAD_DIR, safeKey(partId));
  fs.mkdirSync(dir, { recursive: true });
  const safeName = String(fileName || `model.${kindNorm}`).replace(/[^\w.\- ()а-яА-ЯёЁ]/gi, '_');
  const fileId = `cad-${crypto.randomBytes(4).toString('hex')}`;
  const dest = path.join(dir, `${fileId}-${safeName}`);
  fs.writeFileSync(dest, buffer);
  if (!Array.isArray(part.cadFiles)) part.cadFiles = [];
  part.cadFiles.push({
    id: fileId,
    kind: kindNorm,
    fileName: safeName,
    path: dest,
    size: buffer.length,
    uploadedAt: new Date().toISOString(),
  });
  if (kindNorm === 'stl') part.stlPath = dest;
  if (kindNorm === 'step') part.stepPath = dest;
  return savePart(part);
}

function saveImageBuffer(partId, { fileName, buffer }) {
  const part = loadPart(partId) || upsertPart({ partId });
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  const ext = (path.extname(fileName || '') || '.jpg').toLowerCase();
  const dest = path.join(IMAGES_DIR, `${safeKey(partId)}${ext}`);
  fs.writeFileSync(dest, buffer);
  part.imagePath = dest;
  part.imageSource = 'manual-upload';
  return savePart(part);
}

function readImage(partId) {
  const part = loadPart(partId);
  if (!part || !part.imagePath || !fs.existsSync(part.imagePath)) return null;
  const buf = fs.readFileSync(part.imagePath);
  const ext = path.extname(part.imagePath).toLowerCase();
  const ct = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return { buffer: buf, contentType: ct };
}

function listProfiles() {
  ensureDirs();
  try {
    const j = JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf8'));
    return Array.isArray(j.profiles) ? j.profiles : [];
  } catch { return []; }
}

function saveProfiles(profiles) {
  ensureDirs();
  fs.writeFileSync(PROFILES_PATH, JSON.stringify({ profiles }, null, 2), 'utf8');
}

function addGcodeProfile({ partId, fileName, buffer, material, plateQty, printerType, printTimeMin }) {
  const part = loadPart(partId) || upsertPart({ partId, material });
  fs.mkdirSync(path.join(GCODE_DIR, safeKey(partId)), { recursive: true });
  const id = `gp-${crypto.randomBytes(5).toString('hex')}`;
  const safeName = String(fileName || 'job.gcode').replace(/[^\w.\- ()а-яА-ЯёЁ]/gi, '_');
  const dest = path.join(GCODE_DIR, safeKey(partId), `${id}-${safeName}`);
  fs.writeFileSync(dest, buffer);
  const profiles = listProfiles();
  const profile = {
    id,
    partId: part.partId,
    partName: part.name,
    fileName: safeName,
    archivePath: dest,
    material: material || part.material || 'PETG',
    plateQty: plateQty != null ? Number(plateQty) : part.plateQty || null,
    printerType: printerType || 'bambu',
    printTimeMin: printTimeMin != null ? Number(printTimeMin) : null,
    createdAt: new Date().toISOString(),
  };
  profiles.push(profile);
  saveProfiles(profiles);
  if (!Array.isArray(part.gcodeProfileIds)) part.gcodeProfileIds = [];
  if (!part.gcodeProfileIds.includes(id)) part.gcodeProfileIds.push(id);
  savePart(part);
  return profile;
}

function loadPlan() {
  ensureDirs();
  try {
    const j = JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8'));
    return Array.isArray(j.items) ? j.items : [];
  } catch { return []; }
}

function savePlan(items) {
  ensureDirs();
  fs.writeFileSync(PLAN_PATH, JSON.stringify({ items, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
}

function addPlanItem({ partId, qty, gcodeProfileId, material, notes, preferredPrinterType }) {
  const part = loadPart(partId);
  if (!part) throw new Error('Деталь не найдена — сначала создайте карточку');
  const items = loadPlan();
  const item = {
    id: `plan-${crypto.randomBytes(5).toString('hex')}`,
    partId: part.partId,
    name: part.name,
    qty: Math.max(1, Number(qty) || 1),
    material: material || part.material || 'PETG',
    gcodeProfileId: gcodeProfileId || (part.gcodeProfileIds || [])[0] || null,
    preferredPrinterType: preferredPrinterType || null,
    notes: notes || '',
    status: 'planned',
    createdAt: new Date().toISOString(),
  };
  items.unshift(item);
  savePlan(items);
  return item;
}

function removePlanItem(id) {
  const items = loadPlan().filter(i => i.id !== id);
  savePlan(items);
  return { ok: true };
}

function listPlan() {
  const progress = loadProgress();
  const items = loadPlan().map(it => {
    const part = loadPart(it.partId);
    return {
      ...it,
      part: part ? enrichPart(part, progress) : null,
      profile: listProfiles().find(p => p.id === it.gcodeProfileId) || null,
    };
  });
  return { ok: true, items };
}

/** Push plan item(s) into SaaS queue_jobs via callback addQueueJob(job). */
function enqueuePlanItem(planId, addQueueJob) {
  const items = loadPlan();
  const item = items.find(i => i.id === planId);
  if (!item) throw new Error('План не найден');
  const profile = listProfiles().find(p => p.id === item.gcodeProfileId);
  const jobId = `wh-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
  const job = {
    id: jobId,
    name: item.name || item.partId,
    material: item.material || 'PETG',
    status: 'queued',
    priority: 1,
    hours: profile?.printTimeMin ? profile.printTimeMin / 60 : null,
    gcode_file: profile?.fileName || null,
    notes: `warehouse plan ${item.id}` + (item.notes ? ` · ${item.notes}` : ''),
    created_at: new Date().toISOString(),
    warehouse_plan_id: item.id,
    warehouse_part_id: item.partId,
    warehouse_profile_id: item.gcodeProfileId || null,
    warehouse_qty: item.qty,
  };
  addQueueJob(job);
  item.status = 'queued';
  item.queueJobId = jobId;
  item.queuedAt = new Date().toISOString();
  savePlan(items);
  return { ok: true, job, item };
}

function syncFromFarmBff(srcDir) {
  const src = srcDir || defaultFarmBffParts();
  if (!src || !fs.existsSync(src)) {
    return { ok: false, error: 'Источник farm-bff/data/parts не найден', src };
  }
  ensureDirs();
  let imported = 0, skipped = 0;
  for (const f of fs.readdirSync(src)) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(src, f), 'utf8'));
      const partId = raw.partId || path.basename(f, '.json');
      const existing = loadPart(partId);
      if (existing && existing.sources && existing.sources.includes('saas-edit')) {
        skipped++;
        continue;
      }
      const part = {
        ...raw,
        partId,
        sources: Array.from(new Set([...(raw.sources || []), 'farm-bff-sync'])),
        syncedAt: new Date().toISOString(),
      };
      // Keep absolute paths from farm-bff if they exist; otherwise blank image
      if (part.imagePath && !fs.existsSync(part.imagePath)) part.imagePath = '';
      savePart(part);
      imported++;
    } catch {
      skipped++;
    }
  }
  // Also copy gcode-profiles.json if present next to parts
  const gpSrc = path.join(path.dirname(src), 'gcode-profiles.json');
  if (fs.existsSync(gpSrc)) {
    try {
      const j = JSON.parse(fs.readFileSync(gpSrc, 'utf8'));
      const arr = Array.isArray(j) ? j : (j.profiles || []);
      if (arr.length) {
        const cur = listProfiles();
        const byId = new Map(cur.map(p => [p.id, p]));
        for (const p of arr) if (p && p.id) byId.set(p.id, p);
        saveProfiles([...byId.values()]);
      }
    } catch {}
  }
  return { ok: true, src, imported, skipped, total: listPartsMeta().length };
}

function status() {
  const progress = loadProgress();
  return {
    ok: true,
    warehouseDir: WH_ROOT,
    partsCount: listPartsMeta().length,
    planCount: loadPlan().length,
    profilesCount: listProfiles().length,
    farmBffParts: defaultFarmBffParts(),
    otm: { dir: progress.otmDir, connected: !!progress.ok, error: progress.error || null },
  };
}

module.exports = {
  ensureDirs,
  listWarehouse,
  getPartCard,
  upsertPart,
  loadPart,
  saveCadBuffer,
  saveImageBuffer,
  readImage,
  addGcodeProfile,
  listProfiles,
  listPlan,
  addPlanItem,
  removePlanItem,
  enqueuePlanItem,
  syncFromFarmBff,
  status,
  WH_ROOT,
  PARTS_DIR,
  defaultFarmBffParts,
  // OTM accounting
  applyCollect: (body) => otmBridge.applyCollect(body),
  applyScrap: (body) => otmBridge.applyScrap(body),
  applyStockSettings: (body) => otmBridge.applyStockSettings(body),
  listCollectJournal: (q) => otmBridge.listJournal(q),
  scrapReasons: () => ({ ...otmBridge.SCRAP_REASONS }),
};
