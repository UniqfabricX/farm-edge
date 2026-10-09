'use strict';

/**
 * Живая проверка облака, к которому подключается Farm Edge.
 * npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const CLOUD = process.env.EDGE_CLOUD_URL || 'https://farm.5dsap.ru';

async function get(path, options = {}) {
  const response = await fetch(CLOUD + path, {
    redirect: 'manual',
    signal: AbortSignal.timeout(12_000),
    ...options,
  });
  return response;
}

test('облако farm.5dsap.ru отвечает и отдаёт установщик Farm Edge', async () => {
  const health = await get('/health');
  assert.equal(health.status, 200);
  const body = await health.json();
  assert.equal(body.status, 'ok');
  assert.ok(['ok', 'slow'].includes(body.db), `db=${body.db}`);

  const home = await get('/');
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.match(html, /FarmEdge-Setup\.exe/);
  assert.match(html, /edgeSetupCard|Получить код привязки|код привязки/i);

  const installer = await get('/downloads/FarmEdge-Setup.exe', { method: 'HEAD' });
  assert.equal(installer.status, 200);
  const length = Number(installer.headers.get('content-length') || 0);
  assert.ok(length > 1_000_000, `установщик слишком маленький: ${length}`);
});
