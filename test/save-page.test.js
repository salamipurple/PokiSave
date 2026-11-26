'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { gameSlugFromInstallInput, parseCli, startServer, stripPokiSdk } = require('../save_page');

test('starts a game after replacing a removed Poki SDK load callback', () => {
  const html = [
    '<html><head><meta charset="utf-8">',
    '<script src="https://game-cdn.poki.com/scripts/poki-sdk.js"></script>',
    '</head><body>',
    '<script>function poki_sdk_loaded() { window.gameStarted = true; }</script>',
    '</body></html>',
  ].join('');

  const transformed = stripPokiSdk(html);
  const gameCallback = transformed.indexOf('function poki_sdk_loaded');
  const offlineCallback = transformed.indexOf('data-pokisave-sdk-load-callback');
  const bodyEnd = transformed.indexOf('</body>');

  assert.equal(transformed.includes('https://game-cdn.poki.com/scripts/poki-sdk.js'), false);
  assert.ok(gameCallback >= 0);
  assert.ok(offlineCallback > gameCallback);
  assert.ok(bodyEnd > offlineCallback);
  assert.match(transformed, /window\.addEventListener\("load"/);
});

test('does not add an SDK callback to pages that do not define one', () => {
  const transformed = stripPokiSdk('<html><head></head><body><main>Offline game</main></body></html>');
  assert.equal(transformed.includes('data-pokisave-sdk-load-callback'), false);
});

test('parses update-all and single-game commands', () => {
  const all = parseCli(['update']);
  assert.equal(all.updateCommand, true);
  assert.equal(all.game, undefined);
  assert.equal(all.gamesDir, path.resolve('games'));

  const one = parseCli(['update', '-g', 'drive-mad']);
  assert.equal(one.updateCommand, true);
  assert.equal(one.game, 'drive-mad');
  assert.equal(parseCli(['update', '--game', 'drive-mad']).game, 'drive-mad');
});

test('accepts Poki game slugs and canonical game URLs for GUI installs', () => {
  assert.equal(gameSlugFromInstallInput('drive-mad'), 'drive-mad');
  assert.equal(gameSlugFromInstallInput('https://poki.com/en/g/Stickman-Hook?ref=home'), 'stickman-hook');
  assert.equal(gameSlugFromInstallInput('https://example.com/en/g/not-poki'), undefined);
  assert.equal(gameSlugFromInstallInput('https://poki.com/en/game/unsupported'), undefined);
});

test('library includes install controls and thumbnails and rejects invalid task requests', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pokisave-update-test-'));
  const gameDir = path.join(temp, 'drive-mad');
  fs.mkdirSync(gameDir);
  fs.writeFileSync(path.join(gameDir, 'index.html'), '<h1>Drive Mad</h1>');
  fs.writeFileSync(path.join(gameDir, '_screenshot.png'), 'thumbnail');
  let server;

  try {
    server = await startServer({ serveDir: temp, serveLibrary: true, port: 0, isolate: false });
    const base = `http://127.0.0.1:${server.address().port}`;
    const library = await (await fetch(base)).text();
    assert.match(library, /id="install-form"/);
    assert.match(library, /id="install-game"/);
    assert.match(library, /src="\/drive-mad\/_screenshot\.png"/);
    assert.match(library, /id="update-all"/);
    assert.match(library, /class="update-game" data-game="drive-mad"/);
    assert.doesNotMatch(library, /\bplay\b/i);
    const inlineScript = [...library.matchAll(/<script>([\s\S]*?)<\/script>/g)][0]?.[1];
    assert.ok(inlineScript);
    assert.doesNotThrow(() => new vm.Script(inlineScript));

    const invalidInstall = await fetch(`${base}/__pokisave/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ game: 'https://example.com/en/g/not-poki' }),
    });
    assert.equal(invalidInstall.status, 400);

    const existingInstall = await fetch(`${base}/__pokisave/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ game: 'drive-mad' }),
    });
    assert.equal(existingInstall.status, 409);

    const invalid = await fetch(`${base}/__pokisave/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ game: '../outside' }),
    });
    assert.equal(invalid.status, 400);

    const crossOrigin = await fetch(`${base}/__pokisave/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' },
      body: JSON.stringify({}),
    });
    assert.equal(crossOrigin.status, 403);

    const missing = await fetch(`${base}/__pokisave/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ game: 'not-saved' }),
    });
    assert.equal(missing.status, 404);

    const unknownJob = await fetch(`${base}/__pokisave/jobs/00000000-0000-4000-8000-000000000000`);
    assert.equal(unknownJob.status, 404);

    fs.rmSync(gameDir, { recursive: true, force: true });
    const started = await fetch(`${base}/__pokisave/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(started.status, 202);
    const { jobId } = await started.json();
    let job;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      job = await (await fetch(`${base}/__pokisave/jobs/${jobId}`)).json();
      if (job.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(job.kind, 'update');
    assert.equal(job.status, 'complete');
    assert.equal(job.updated, 0);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
