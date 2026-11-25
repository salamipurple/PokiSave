'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { stripPokiSdk } = require('../save_page');

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
