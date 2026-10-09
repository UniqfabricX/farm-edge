'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const VERSION = require('./package.json').version;

function defaultDataDir() {
  if (process.env.FARM_EDGE_DATA) return process.env.FARM_EDGE_DATA;
  if (process.platform === 'win32') {
    const base = process.env.PROGRAMDATA || 'C:\\ProgramData';
    return path.join(base, 'farm-edge');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'farm-edge');
  }
  return '/var/lib/farm-edge';
}

function ensureDataDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {}
}

function credPath(dir) {
  return path.join(dir, 'credentials.json');
}

function loadCredentials(dir) {
  const p = credPath(dir);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function saveCredentials(dir, obj) {
  ensureDataDir(dir);
  const p = credPath(dir);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(p, 0o600);
  } catch {}
}

function cloudHttpBase(cloudUrl) {
  const u = String(cloudUrl || process.env.EDGE_CLOUD_URL || 'https://farm.5dsap.ru').replace(/\/$/, '');
  return u.replace(/\/$/, '');
}

function farmBffUrl() {
  return String(process.env.FARM_BFF_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
}

module.exports = {
  VERSION,
  defaultDataDir,
  ensureDataDir,
  loadCredentials,
  saveCredentials,
  cloudHttpBase,
  farmBffUrl,
};
