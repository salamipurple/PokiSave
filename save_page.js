#!/usr/bin/env node
'use strict';

/**
 * PokiSave
 *
 * Saves a Poki game (the page's nested game iframe) and everything it loads, for offline use.
 *
 * How it works:
 *   1. Open the Poki page in Chrome and read the game iframe's URL.
 *   2. Load the page again and let the game run inside its real iframe (the game host refuses
 *      direct loads), saving every response that belongs to the game. The game's runtime requests
 *      are what we want, and no HTML scraping can find those.
 *   3. If only --game-url is given (no page), load it directly. If the browser can't, fall back to
 *      curl, which only finds files named in the HTML.
 *
 * Output layout mirrors the original URLs so the game's runtime paths keep working:
 *   <out>/<url path>                  files from the game's host (the page sits at its original path)
 *   <out>/_assets/<host>/<url path>   files from other hosts
 *   <out>/index.html                  redirect to the game page
 * Serve <out> over HTTP (file:// won't work), e.g.  python3 -m http.server 8000 -d <out>
 *
 * Requires Node 22.12+ and `puppeteer`. curl is needed for the fallback paths.
 * Install with `npm install -g pokisave`; run `pokisave --help` for options.
 */

const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { execFileSync } = require('child_process');
const { parseArgs } = require('util');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

// Replaces the real Poki SDK. Unknown methods become no-ops so a missing method can't crash the game.
const POKI_SDK_STUB_JS = `(function () {
  var noop = function () {};
  var resolves = function (value) { return function () { return Promise.resolve(value); }; };
  var sdk = {
    init: resolves(),
    commercialBreak: resolves(),
    rewardedBreak: resolves(true),
    shareableURL: resolves(''),
    getPlayerData: resolves(null),
    getURLParam: function () { return ''; },
    isAdBlocked: function () { return false; }
  };
  ['setDebug', 'gameLoadingStart', 'gameLoadingFinished', 'gameLoadingProgress', 'gameplayStart', 'gameplayStop',
   'happyTime', 'displayAd', 'destroyAd', 'captureError', 'logError', 'setPlayerAge', 'togglePlayerAdvertisingConsent',
   'muteAd', 'enableEventTracking', 'measure', 'customEvent', 'movePill', 'setDebugTouchOverlayController',
   'setPlayerData', 'showLeaderboard'].forEach(function (name) { sdk[name] = noop; });
  window.PokiSDK = typeof Proxy === 'function'
    ? new Proxy(sdk, { get: function (target, key) { return key in target || typeof key === 'symbol' || key === 'then' ? target[key] : noop; } })
    : sdk;
})();`;

// Runs first in the saved page. Stops the offline copy from bouncing back to the live site.
const OFFLINE_SHIM_JS = `(function () {
  var tag = '[offline]';
  function sameOrigin(u) { try { return new URL(u, location.href).origin === location.origin; } catch (e) { return false; } }
  // 1. Cancel script-initiated navigations to other origins (site-lock redirects, "more games" links).
  try {
    if (window.navigation && navigation.addEventListener) {
      navigation.addEventListener('navigate', function (e) {
        if (e.cancelable && !sameOrigin(e.destination.url)) {
          e.preventDefault();
          console.warn(tag, 'blocked navigation to', e.destination.url);
        }
      });
    }
  } catch (e) {}
  // 2. Same for window.open.
  try {
    var open = window.open;
    window.open = function (u) {
      if (u && !sameOrigin(u)) { console.warn(tag, 'blocked window.open', u); return null; }
      return open.apply(this, arguments);
    };
  } catch (e) {}
  // 3. Pretend the page was opened from poki.com (referrer-based site locks).
  try { Object.defineProperty(document, 'referrer', { get: function () { return 'https://poki.com/'; }, configurable: true }); } catch (e) {}
  // 4. Never load the real Poki SDK, even when the game injects it dynamically: it would run against the
  //    live service and redirect or hang. The stub is already defined, so an empty script "loads" fine.
  try {
    var isSdk = function (u) { return /poki-sdk/i.test(String(u)); };
    var empty = 'data:text/javascript,';
    var desc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
    Object.defineProperty(HTMLScriptElement.prototype, 'src', {
      configurable: true, enumerable: desc.enumerable, get: desc.get,
      set: function (v) { desc.set.call(this, isSdk(v) ? empty : v); }
    });
    var setAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      if (String(name).toLowerCase() === 'src' && this instanceof HTMLScriptElement && isSdk(value)) value = empty;
      return setAttribute.call(this, name, value);
    };
  } catch (e) {}
})();`;

// Ad / analytics hosts are not saved (like an ad blocker): saved ad scripts would run offline and can hang a game.
const AD_HOST_PATTERN = /(?:^|\.)(?:doubleclick\.net|googlesyndication\.com|googleadservices\.com|google-analytics\.com|googletagmanager\.com|googletagservices\.com|imasdk\.googleapis\.com|amazon-adsystem\.com|adnxs\.com|rubiconproject\.com|pubmatic\.com|criteo\.(?:com|net)|moatads\.com|connect\.facebook\.net|sentry\.io)$/i;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.wasm': 'application/wasm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
};

const USAGE = `PokiSave - capture Poki games for offline play

Usage: pokisave <game-name> [options]
       pokisave <page-url> [options]
       pokisave --game-url <url> [options]
       pokisave serve [--game <game-name>] [options]

Arguments:
  <game-name>              Poki game slug (e.g. drive-mad)
  <page-url>               Full page URL that embeds the game iframe
                           (e.g. https://poki.com/en/g/stickman-hook)

Capture:
  -g, --game-url <url>     Skip iframe detection and use this game URL. Without <page-url> the
                           game is loaded directly, which most hosts block (curl is the fallback)
      --direct             With <page-url>: load the game URL directly instead of through the page
      --curl-only          Skip the browser; scrape with curl (finds only files named in the HTML)
      --no-fallback        Don't fall back to curl if the browser capture fails
      --manual             Open a visible browser and let YOU play to load more assets;
                           press Enter in the terminal when done
      --click <selector>   Click this element after the page loads (e.g. a Play button)
      --idle <ms>          Game counts as loaded after this long with no network activity
                                                               (default: 5000)
      --load-timeout <ms>  Stop waiting for the game to go quiet after this long
                                                               (default: 90000)
      --settle <ms>        Extra wait after that               (default: 2000)
      --autoplay <ms>      After loading, click and press keys for this long to get past menus and
                           trigger lazy loading; 0 disables    (default: 8000)
      --asset <path>       Extra file for curl mode, relative to the game directory (repeatable)

Offline copy:
      --no-shim            Don't inject the offline shim (cross-origin redirect blocking, referrer
                           spoof, dynamic Poki SDK blocking). The SDK stub is still injected
      --keep-ads           Also save ad/analytics scripts (skipped by default)

Serving:
      serve               Browse saved games, or serve one with -g, --game <name>
      --port <n>           Port for serve and --serve           (default: 8000)
      --isolate            Send COOP/COEP headers when serving
      --serve <dir>        Serve a saved folder at http://localhost:<port>/ instead of capturing:
                           Range requests, correct MIME types, and every 404 is logged

Output & browser:
  -o, --out <dir>          Output directory                    (default: ./games/<game-name>)
      --referer <url>      Force this Referer on every request (default: browser-like,
                           i.e. the game URL for the game's own files)
      --user-agent <ua>    User-Agent for curl/direct loads    (default: desktop Chrome)
      --chrome <path>      Chrome/Chromium executable          (default: auto-detect)
      --frame-selector <s> Game iframe selector, searched in every frame
                           on the page at any depth            (default: #gameframe)
      --frame-wait <ms>    How long to wait for that iframe    (default: 30000)
      --viewport <WxH>     Viewport for direct loads           (default: 1280x720)
      --timeout <ms>       Navigation / curl timeout           (default: 60000)
      --keep-sdk           Keep the Poki SDK script/icon instead of stubbing them out
      --headful            Show the browser window
      --screenshot         Save <out>/_screenshot.png after loading
                           (or <out>/_extract-failed.png if the iframe isn't found)
      --manifest           Write <out>/_manifest.json listing every saved file
  -v, --verbose            Debug logging (requests, paths, timings, browser console)
  -q, --quiet              Only print errors
  -h, --help               Show this help

Examples:
  pokisave drive-mad -v
  pokisave stickman-hook --manual
  pokisave serve
  pokisave serve --game drive-mad
  pokisave --serve games/drive-mad
  pokisave -g https://example.game-cdn.com/abc/index.html --curl-only --asset data/levels.json
`;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
const startedAt = Date.now();
let currentLevel = LEVELS.info;

function emit(level, tag, args) {
  if (LEVELS[level] > currentLevel) return;
  const stamp = ((Date.now() - startedAt) / 1000).toFixed(2).padStart(6);
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  out(`[${stamp}s] ${tag}`, ...args);
}

const log = {
  error: (...a) => emit('error', 'ERROR', a),
  warn: (...a) => emit('warn', 'WARN ', a),
  info: (...a) => emit('info', 'INFO ', a),
  debug: (...a) => emit('debug', 'DEBUG', a),
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function die(message) {
  console.error(`Error: ${message}\n\nRun with --help for usage.`);
  process.exit(2);
}

function toInt(name, value, fallback) {
  if (value === undefined) return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) die(`--${name} must be a non-negative integer (got "${value}")`);
  return n;
}

function parseViewport(value = '1280x720') {
  const m = /^(\d+)x(\d+)$/i.exec(value);
  if (!m) die(`--viewport must look like 1280x720 (got "${value}")`);
  return { width: Number(m[1]), height: Number(m[2]), deviceScaleFactor: 1 };
}

function requireHttpUrl(name, value) {
  try {
    const u = new URL(value);
    if (!/^https?:$/.test(u.protocol)) throw new Error('not http(s)');
    return u.href;
  } catch (_) {
    return die(`${name} must be an absolute http(s) URL (got "${value}")`);
  }
}

function isGameName(value) {
  return /^[a-z0-9][a-z0-9-]*$/i.test(value);
}

function gameNameFromUrl(value) {
  try {
    const u = new URL(value);
    const segments = u.pathname.split('/').filter(Boolean);
    let segment = segments.pop();
    if (/^index\.[^.]+$/i.test(segment || '') && segments.length) segment = segments.pop();
    if (segment) segment = segment.replace(/\.[^.]+$/, '');
    return segment && isGameName(segment) ? segment : undefined;
  } catch (_) {
    return undefined;
  }
}

function parseCli(argv) {
  if (argv[0] === 'serve') {
    let parsed;
    try {
      parsed = parseArgs({
        args: argv.slice(1),
        allowPositionals: true,
        options: {
          game: { type: 'string', short: 'g' },
          port: { type: 'string' },
          isolate: { type: 'boolean' },
          verbose: { type: 'boolean', short: 'v' },
          quiet: { type: 'boolean', short: 'q' },
          help: { type: 'boolean', short: 'h' },
        },
      });
    } catch (err) {
      return die(err.message);
    }

    const { values, positionals } = parsed;
    if (values.help) {
      console.log(`Usage: pokisave serve [--game <game-name>] [options]

Options:
  -g, --game <name>  Serve one saved game instead of the game library
      --port <n>     Port to listen on (default: 8000)
      --isolate      Send COOP/COEP headers (SharedArrayBuffer / threaded games)
  -v, --verbose      Log each request
  -q, --quiet        Only print errors
  -h, --help         Show this help
`);
      process.exit(0);
    }
    if (positionals.length) die(`unexpected extra arguments: ${positionals.join(' ')}`);
    if (values.game && !isGameName(values.game)) die(`--game must be a game slug (got "${values.game}")`);

    return {
      serveDir: path.resolve('games', values.game || ''),
      serveLibrary: !values.game,
      port: toInt('port', values.port, 8000),
      isolate: !!values.isolate,
      logLevel: values.quiet ? LEVELS.error : values.verbose ? LEVELS.debug : LEVELS.info,
    };
  }

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        'game-url': { type: 'string', short: 'g' },
        out: { type: 'string', short: 'o' },
        referer: { type: 'string' },
        'user-agent': { type: 'string' },
        chrome: { type: 'string' },
        'frame-selector': { type: 'string' },
        'frame-wait': { type: 'string' },
        viewport: { type: 'string' },
        timeout: { type: 'string' },
        settle: { type: 'string' },
        idle: { type: 'string' },
        'load-timeout': { type: 'string' },
        click: { type: 'string' },
        autoplay: { type: 'string' },
        serve: { type: 'string' },
        port: { type: 'string' },
        asset: { type: 'string', multiple: true },
        direct: { type: 'boolean' },
        manual: { type: 'boolean' },
        isolate: { type: 'boolean' },
        'no-shim': { type: 'boolean' },
        'keep-ads': { type: 'boolean' },
        'curl-only': { type: 'boolean' },
        'no-fallback': { type: 'boolean' },
        'keep-sdk': { type: 'boolean' },
        headful: { type: 'boolean' },
        screenshot: { type: 'boolean' },
        manifest: { type: 'boolean' },
        verbose: { type: 'boolean', short: 'v' },
        quiet: { type: 'boolean', short: 'q' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    return die(err.message);
  }

  const { values, positionals } = parsed;
  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }

  let logLevel = LEVELS.info;
  if (values.quiet) logLevel = LEVELS.error;
  if (values.verbose) logLevel = LEVELS.debug;

  if (values.serve) {
    return {
      serveDir: path.resolve(values.serve),
      port: toInt('port', values.port, 8000),
      isolate: !!values.isolate,
      logLevel,
    };
  }

  if (positionals.length > 1) die(`unexpected extra arguments: ${positionals.slice(1).join(' ')}`);
  if (!positionals[0] && !values['game-url']) die('missing <game-name> (or pass --game-url)');
  if (values['curl-only'] && values['no-fallback']) die('--curl-only and --no-fallback cannot be combined');
  if (values['curl-only'] && values.manual) die('--manual needs a browser; it cannot be combined with --curl-only');

  let gameName;
  let pageUrl;
  if (positionals[0]) {
    if (isGameName(positionals[0])) {
      gameName = positionals[0];
      pageUrl = `https://poki.com/en/g/${encodeURIComponent(gameName)}`;
    } else {
      pageUrl = requireHttpUrl('<page-url>', positionals[0]);
      gameName = gameNameFromUrl(pageUrl);
    }
  }
  const gameUrl = values['game-url'] ? requireHttpUrl('--game-url', values['game-url']) : undefined;
  if (!gameName) gameName = gameUrl ? gameNameFromUrl(gameUrl) : undefined;

  return {
    pageUrl,
    gameUrl,
    outDir: path.resolve(values.out || (gameName ? path.join('games', gameName) : 'games')),
    referer: values.referer || pageUrl || gameUrl,
    userAgent: values['user-agent'] || DEFAULT_USER_AGENT,
    chromePath: values.chrome,
    frameSelector: values['frame-selector'] || '#gameframe',
    frameWait: toInt('frame-wait', values['frame-wait'], 30000),
    // Overrides the user asked for explicitly; page loads stay vanilla otherwise.
    explicit: {
      userAgent: !!values['user-agent'],
      referer: !!values.referer,
      viewport: !!values.viewport,
    },
    viewport: parseViewport(values.viewport),
    timeout: toInt('timeout', values.timeout, 60000),
    settle: toInt('settle', values.settle, 2000),
    idle: toInt('idle', values.idle, 5000),
    loadTimeout: toInt('load-timeout', values['load-timeout'], 90000),
    click: values.click,
    autoplay: toInt('autoplay', values.autoplay, 8000),
    coreAssets: values.asset || [],
    direct: !!values.direct,
    manual: !!values.manual,
    curlOnly: !!values['curl-only'],
    noFallback: !!values['no-fallback'],
    keepSdk: !!values['keep-sdk'],
    keepAds: !!values['keep-ads'],
    noShim: !!values['no-shim'],
    headful: !!values.headful || !!values.manual,
    screenshot: !!values.screenshot,
    manifest: !!values.manifest,
    logLevel,
  };
}

// ---------------------------------------------------------------------------
// Path / URL helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function originOf(rawUrl) {
  try {
    return new URL(rawUrl).origin;
  } catch (_) {
    return '';
  }
}

/**
 * Map a URL to a relative (posix-style) path inside the output directory.
 * Same-origin files keep their URL path; everything else goes under _assets/<host>/.
 */
function urlToRelativePath(rawUrl, sourceOrigin) {
  const u = new URL(rawUrl);
  let pathname = u.pathname;
  if (pathname.endsWith('/')) pathname += 'index.html';

  const segments = pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch (_) {
        /* keep raw segment */
      }
      return decoded.replace(/[\\\/<>:"|?*\u0000-\u001F]/g, '_');
    })
    .filter((s) => s !== '.' && s !== '..');

  const rel = segments.join('/') || 'index.html';
  return u.origin === sourceOrigin ? rel : `_assets/${u.hostname}/${rel}`;
}

/** Percent-encode each path segment so it is safe to put in an href/src. */
function toHref(rel) {
  return rel.split('/').map(encodeURIComponent).join('/');
}

/** Relative href from the saved page (fromRel) to another saved file (toRel). */
function relHref(fromRel, toRel) {
  const rel = path.posix.relative(path.posix.dirname(fromRel), toRel) || path.posix.basename(toRel);
  const href = toHref(rel);
  return href.startsWith('.') ? href : `./${href}`;
}

/** Resolve rel under root, returning null if it would escape root. */
function safeJoin(root, rel) {
  const resolvedRoot = path.resolve(root);
  const full = path.resolve(resolvedRoot, rel);
  return full.startsWith(resolvedRoot + path.sep) ? full : null;
}

function isSkippableRef(value) {
  return value.startsWith('#') || /^(?:data|javascript|blob):/i.test(value);
}

function escapeHtmlAttr(value) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function summarizeFiles(files) {
  const byExt = {};
  let total = 0;
  for (const f of files) {
    const ext = (path.extname(f.path).slice(1) || 'other').toLowerCase();
    byExt[ext] = (byExt[ext] || 0) + 1;
    total += f.bytes || 0;
  }
  const parts = Object.entries(byExt)
    .sort((a, b) => b[1] - a[1])
    .map(([ext, n]) => `${ext} ${n}`)
    .join(', ');
  return `${files.length} file(s), ${(total / 1048576).toFixed(1)} MB (${parts})`;
}

function isPokiSdkUrl(u) {
  return /poki-sdk/i.test(u.pathname) || (u.hostname === 'game-cdn.poki.com' && u.pathname.startsWith('/scripts/'));
}

/** Why a URL should not be saved, or null. The Poki SDK is replaced by a stub; ad hosts are skipped. */
function skipReasonFor(opts, u) {
  if (!opts.keepSdk && isPokiSdkUrl(u)) return 'Poki SDK, replaced by the offline stub';
  if (!opts.keepAds && AD_HOST_PATTERN.test(u.hostname)) return 'ad/analytics host';
  return null;
}

// ---------------------------------------------------------------------------
// Output bookkeeping
// ---------------------------------------------------------------------------

function recordFile(ctx, entry) {
  const previous = ctx.pathOwners.get(entry.path);
  if (previous && previous !== entry.url) {
    log.warn(`Path collision: ${entry.path} was ${previous}, now overwritten by ${entry.url}`);
  }
  ctx.pathOwners.set(entry.path, entry.url);
  ctx.files.push(entry);
}

function writeManifest(ctx, mode) {
  const manifestPath = path.join(ctx.outDir, '_manifest.json');
  const manifest = {
    pageUrl: ctx.opts.pageUrl || null,
    sourceUrl: ctx.sourceUrl,
    mode,
    savedAt: new Date().toISOString(),
    files: ctx.files,
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  log.info(`Wrote manifest: ${manifestPath}`);
}

/** Writes the game page at its original path, plus a root index.html that redirects to it. */
function writeOutputPage(ctx, html, pageRel) {
  const pagePath = safeJoin(ctx.outDir, pageRel);
  if (!pagePath) throw new Error(`Refusing to write the page outside the output dir (${pageRel})`);
  fs.mkdirSync(path.dirname(pagePath), { recursive: true });
  fs.writeFileSync(pagePath, html, 'utf8');
  log.debug(`Wrote ${pageRel} (${Buffer.byteLength(html)} bytes)`);

  if (pageRel === 'index.html') return;

  let query = '';
  try {
    query = new URL(ctx.sourceUrl).search; // the game was loaded with these parameters
  } catch (_) {
    /* none */
  }
  const target = `./${toHref(pageRel)}${query}`;
  const redirect =
    '<!doctype html>\n<meta charset="utf-8">\n<title>Redirecting…</title>\n' +
    `<meta http-equiv="refresh" content="0; url=${escapeHtmlAttr(target)}">\n` +
    `<script>location.replace(${JSON.stringify(target).replace(/</g, '\\u003c')} + location.hash);</script>\n` +
    `<a href="${escapeHtmlAttr(target)}">Open the game</a>\n`;
  fs.writeFileSync(path.join(ctx.outDir, 'index.html'), redirect, 'utf8');
  log.debug(`Wrote index.html redirect -> ${target}`);
}

// ---------------------------------------------------------------------------
// HTML transforms
// ---------------------------------------------------------------------------

/**
 * Removes the Poki SDK <script>/<link rel=icon> and injects the offline shim + SDK stub as the first script
 * (after <meta charset>, which has to stay within the first 1024 bytes).
 */
function stripPokiSdk(html, { shim = true } = {}) {
  let removed = 0;
  const count = () => {
    removed += 1;
    return '';
  };

  html = html.replace(/<script[^>]+src=["'][^"']*poki-sdk[^"']*["'][^>]*><\/script>/gi, count);
  html = html.replace(/<link[^>]+rel=["']icon["'][^>]*>/gi, count);

  const injection = `<script>${shim ? `${OFFLINE_SHIM_JS}\n` : ''}${POKI_SDK_STUB_JS}</script>`;
  let at = 0;
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  if (head) {
    at = head.index + head[0].length;
    const meta = /<meta[^>]+charset[^>]*>/i.exec(html);
    const firstScript = html.search(/<script/i);
    if (meta && meta.index >= at && (firstScript === -1 || meta.index < firstScript)) at = meta.index + meta[0].length;
  }
  html = html.slice(0, at) + injection + html.slice(at);
  if (/\bpoki_sdk_loaded\b/.test(html) && !html.includes('data-pokisave-sdk-load-callback')) {
    const callback = '<script data-pokisave-sdk-load-callback>window.addEventListener("load", function () { if (typeof window.poki_sdk_loaded === "function") window.poki_sdk_loaded(); }, { once: true });</script>\n';
    const bodyEnd = /<\/body\s*>/i;
    html = bodyEnd.test(html) ? html.replace(bodyEnd, `${callback}$&`) : `${html}\n${callback}`;
  }
  log.debug(`Poki SDK: removed ${removed} tag(s), injected ${shim ? 'shim + ' : ''}stub at offset ${at}`);
  return html;
}

function extractUrlsFromHtml(html, baseUrl) {
  const urls = new Set();
  for (const match of html.matchAll(/(?:src|href|poster)=["']([^"']+)["']/gi)) {
    const value = match[1];
    if (isSkippableRef(value)) continue;
    try {
      const u = new URL(value, baseUrl);
      if (!/^https?:$/.test(u.protocol)) continue; // never hand file:/ftp: etc. to curl
      u.hash = '';
      urls.add(u.href);
    } catch (_) {
      log.debug(`Ignoring unparsable URL in HTML: ${value}`);
    }
  }
  return urls;
}

/** Point src/href/poster attributes at the local copies that exist on disk, relative to the saved page. */
function rewriteHtmlRefs(html, baseUrl, ctx, pageRel) {
  let rewritten = 0;
  const result = html.replace(/((?:src|href|poster)=["'])([^"']+)(["'])/gi, (match, prefix, value, suffix) => {
    if (isSkippableRef(value)) return match;
    try {
      const abs = new URL(value, baseUrl);
      if (!/^https?:$/.test(abs.protocol)) return match;
      const hash = abs.hash;
      abs.hash = '';
      const rel = urlToRelativePath(abs.href, ctx.sourceOrigin);
      const filepath = safeJoin(ctx.outDir, rel);
      if (filepath && fs.existsSync(filepath)) {
        rewritten += 1;
        return `${prefix}${relHref(pageRel, rel)}${hash}${suffix}`;
      }
    } catch (_) {
      /* leave untouched */
    }
    return match;
  });
  log.debug(`Rewrote ${rewritten} attribute reference(s) to local paths`);
  return result;
}

/** Warns about references in the saved page that don't resolve to a saved file. */
function verifyLocalRefs(ctx, html, pageRel) {
  const missing = new Set();
  const remote = new Set();
  let checked = 0;

  for (const match of html.matchAll(/(?:src|href|poster)=["']([^"']+)["']/gi)) {
    const value = match[1];
    if (isSkippableRef(value)) continue;
    if (/^(?:https?:)?\/\//i.test(value)) {
      remote.add(value);
      continue;
    }
    checked += 1;
    let clean = value.split(/[?#]/)[0];
    try {
      clean = decodeURIComponent(clean);
    } catch (_) {
      /* keep raw */
    }
    const rel = clean.startsWith('/')
      ? clean.replace(/^\/+/, '')
      : path.posix.join(path.posix.dirname(pageRel), clean);
    const full = safeJoin(ctx.outDir, rel);
    if (!full || !fs.existsSync(full)) missing.add(rel);
  }

  if (missing.size) {
    log.warn(`The saved page references ${missing.size} local file(s) that were not saved:`);
    for (const rel of [...missing].slice(0, 10)) log.warn(`  ${rel}`);
    if (missing.size > 10) log.warn(`  ... and ${missing.size - 10} more`);
  } else {
    log.debug(`Verified ${checked} local reference(s): all present`);
  }

  const stillRemote = [...remote].filter((u) => originOf(new URL(u, ctx.sourceUrl).href) === ctx.sourceOrigin);
  if (stillRemote.length) {
    log.warn(`The saved page still points ${stillRemote.length} reference(s) at ${ctx.sourceOrigin} (not saved locally)`);
    for (const u of stillRemote.slice(0, 5)) log.debug(`  remote: ${u}`);
  }
  return { missing: missing.size, remote: stillRemote.length };
}

/** Optional game-specific tweak: some Poki wrappers ship a debug flag in webapp/source_min.js. */
function patchGameSource(ctx) {
  const baseDir = new URL('.', ctx.sourceUrl).href;
  const scriptUrl = new URL('webapp/source_min.js', baseDir).href;
  const scriptPath = safeJoin(ctx.outDir, urlToRelativePath(scriptUrl, ctx.sourceOrigin));
  if (!scriptPath || !fs.existsSync(scriptPath)) {
    log.debug('No webapp/source_min.js saved; nothing to patch');
    return;
  }
  const needle = 'var pokiDebug=false';
  let code = fs.readFileSync(scriptPath, 'utf8');
  if (code.includes(needle)) {
    code = code.replace(needle, () => 'var pokiDebug=true');
    fs.writeFileSync(scriptPath, code, 'utf8');
    log.debug('Patched source_min.js: pokiDebug=true');
  } else {
    log.debug('source_min.js: pokiDebug marker not found');
  }
}

const TEXT_FILE = /\.(?:m?js|html?|json)$/i;
const LOCK_PATTERNS = [
  { label: 'siteblock', re: /siteblock/i, level: 'warn' },
  { label: 'redirect to poki.com', re: /location(?:\.href)?\s*=\s*["'`]https?:\/\/(?:www\.)?poki\.com/i, level: 'warn' },
  { label: 'top/parent location', re: /\b(?:top|parent)\.location\b/, level: 'info' },
  { label: 'ancestorOrigins', re: /ancestorOrigins/, level: 'info' },
  { label: 'document.referrer', re: /document\.referrer/, level: 'info' },
];

/** Scans the saved text files for site-lock style code, to explain games that bail out offline. */
function diagnoseSaved(ctx) {
  const found = new Map();
  for (const f of ctx.files) {
    if (!TEXT_FILE.test(f.path) || (f.bytes || 0) > 12 * 1048576) continue;
    let text;
    try {
      text = fs.readFileSync(safeJoin(ctx.outDir, f.path), 'utf8');
    } catch (_) {
      continue;
    }
    for (const p of LOCK_PATTERNS) {
      const m = p.re.exec(text);
      if (!m) continue;
      if (!found.has(p.label)) found.set(p.label, { level: p.level, files: [] });
      found.get(p.label).files.push(f.path);
      const snippet = text.slice(Math.max(0, m.index - 60), m.index + 100).replace(/\s+/g, ' ');
      log.debug(`[scan] ${p.label} in ${f.path}: ...${snippet}...`);
    }
  }
  if (!found.size) {
    log.debug('[scan] no site-lock style code found');
    return found;
  }
  for (const [label, { level, files }] of found) {
    const names = files.slice(0, 3).join(', ') + (files.length > 3 ? `, +${files.length - 3} more` : '');
    (level === 'warn' ? log.warn : log.info)(`[scan] ${label} found in: ${names}`);
  }
  log.info('[scan] Cross-origin redirects are blocked by the offline shim. If the game still bails out offline, ' +
    'check these files (-v shows the matching code).');
  return found;
}

/**
 * Takes the raw game page (saved earlier, or fallbackHtml), rewrites references, stubs the SDK,
 * and writes the final page + root redirect.
 */
function finalizePage(ctx, fallbackHtml) {
  const { opts } = ctx;
  const pageRel = urlToRelativePath(ctx.sourceUrl, ctx.sourceOrigin);
  const pagePath = safeJoin(ctx.outDir, pageRel);

  let html = null;
  if (pagePath && fs.existsSync(pagePath)) html = fs.readFileSync(pagePath, 'utf8');
  else if (fallbackHtml) html = fallbackHtml;
  if (!html) throw new Error('Could not obtain the game page HTML (it was never captured)');

  diagnoseSaved(ctx);
  html = rewriteHtmlRefs(html, ctx.sourceUrl, ctx, pageRel);
  if (!opts.keepSdk) html = stripPokiSdk(html, { shim: !opts.noShim });
  patchGameSource(ctx);
  writeOutputPage(ctx, html, pageRel);
  verifyLocalRefs(ctx, html, pageRel);
}

// ---------------------------------------------------------------------------
// Browser helpers
// ---------------------------------------------------------------------------

function findChrome(explicit) {
  if (explicit) return explicit;
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  return CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));
}

async function launchBrowser(opts) {
  const puppeteer = require('puppeteer'); // lazy so --help works without it installed
  const executablePath = findChrome(opts.chromePath);
  log.debug(`Launching browser: ${executablePath || '(puppeteer bundled Chromium)'}, headless=${!opts.headful}`);
  return puppeteer.launch({
    headless: !opts.headful,
    ...(executablePath ? { executablePath } : {}),
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });
}

async function createPage(browser, opts, label, { applyOverrides = true } = {}) {
  const page = await browser.newPage();

  // With applyOverrides=false only the flags the user passed explicitly are applied.
  const headers = {};
  if (applyOverrides) headers['Accept-Language'] = 'en-US,en;q=0.9';
  if (applyOverrides || opts.explicit.referer) headers.Referer = opts.referer;

  if (applyOverrides || opts.explicit.viewport) await page.setViewport(opts.viewport);
  if (applyOverrides || opts.explicit.userAgent) await page.setUserAgent(opts.userAgent);
  if (Object.keys(headers).length) await page.setExtraHTTPHeaders(headers);
  log.debug(
    `[${label}] page overrides: viewport=${applyOverrides || opts.explicit.viewport}, ` +
      `userAgent=${applyOverrides || opts.explicit.userAgent}, headers=${Object.keys(headers).join(',') || 'none'}`
  );

  page.on('console', (msg) => log.debug(`[${label}:console.${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) => log.debug(`[${label}:pageerror] ${err.message}`));
  page.on('requestfailed', (req) => {
    const failure = req.failure();
    log.debug(`[${label}:requestfailed] ${req.url()} (${failure ? failure.errorText : 'unknown'})`);
  });
  return page;
}

// ---------------------------------------------------------------------------
// Step 1: find the game URL inside the Poki page
// ---------------------------------------------------------------------------

/**
 * Looks for the game iframe in every frame of the page (any nesting depth) and returns its URL.
 * Polls until opts.frameWait elapses, because the iframe may be created late.
 * @returns {Promise<{src: string, foundIn: string} | null>}
 */
async function findGameFrame(page, opts) {
  const deadline = Date.now() + opts.frameWait;
  let round = 0;

  do {
    round += 1;
    const frames = page.frames();
    log.debug(`Search round ${round}: ${frames.length} frame(s)`);

    for (const frame of frames) {
      let handle = null;
      try {
        handle = await frame.$(opts.frameSelector);
      } catch (_) {
        continue; // frame detached mid-search
      }
      if (!handle) continue;

      const where = frame.url() || '(blank)';
      const attrs = await handle.evaluate((el) => ({
        tag: String(el.tagName).toLowerCase(),
        src: el.src || el.getAttribute('data-src') || '',
      }));
      log.debug(`Matched ${opts.frameSelector} (<${attrs.tag}>) in frame ${where}; src="${attrs.src}"`);

      let src = '';
      try {
        src = attrs.src ? new URL(attrs.src, frame.url()).href : '';
      } catch (_) {
        src = attrs.src;
      }

      // No usable src attribute: use the URL the iframe actually loaded.
      if (!src || src === 'about:blank') {
        const child = await handle.contentFrame();
        const childUrl = child ? child.url() : '';
        log.debug(`No src attribute; iframe's loaded URL is "${childUrl}"`);
        if (childUrl && childUrl !== 'about:blank') src = childUrl;
      }

      if (src && src !== 'about:blank') return { src, foundIn: where };
      log.debug('Matched element has no usable URL yet; will keep polling');
    }

    if (Date.now() < deadline) await sleep(500);
  } while (Date.now() < deadline);

  return null;
}

/** Human-readable dump of the page's frame tree, for diagnosing selector misses. */
async function describePage(page) {
  const title = await page.title().catch(() => '?');
  const lines = [`page title: "${title}"`, `page url:   ${page.url()}`];

  for (const frame of page.frames()) {
    lines.push(`frame: ${frame.url() || '(blank)'}`);
    let iframes = [];
    try {
      iframes = await frame.$$eval('iframe', (els) =>
        els.map((e) => ({
          id: e.id || null,
          name: e.name || null,
          src: e.getAttribute('src') || e.getAttribute('data-src') || null,
        }))
      );
    } catch (_) {
      lines.push('    (could not inspect frame)');
      continue;
    }
    if (!iframes.length) lines.push('    (no <iframe> elements)');
    for (const f of iframes) {
      lines.push(`    <iframe id=${f.id} name=${f.name} src=${f.src ? f.src.slice(0, 200) : null}>`);
    }
  }
  return lines.join('\n');
}

async function extractGameUrl(opts) {
  log.info(`Resolving game iframe on ${opts.pageUrl}`);
  const browser = await launchBrowser(opts);
  try {
    // Vanilla page on purpose: a spoofed UA/Referer/viewport can make the site serve a different
    // page. Those overrides only apply here if you passed the matching flags explicitly.
    const page = await createPage(browser, opts, 'extract', { applyOverrides: false });

    log.debug('Navigating to page (waitUntil=networkidle2)');
    await page.goto(opts.pageUrl, { waitUntil: 'networkidle2', timeout: opts.timeout });
    log.debug(`Page loaded: "${await page.title()}"`);

    log.debug(`Searching all frames for ${opts.frameSelector} (up to ${opts.frameWait}ms)`);
    const found = await findGameFrame(page, opts);

    if (!found) {
      log.warn(`Frame tree when giving up:\n${await describePage(page)}`);
      if (opts.screenshot) {
        const shot = path.join(opts.outDir, '_extract-failed.png');
        await page.screenshot({ path: shot }).then(
          () => log.info(`Saved ${shot}`),
          (err) => log.debug(`Screenshot failed: ${err.message}`)
        );
      }
      throw new Error(
        `No ${opts.frameSelector} with a usable URL found in any frame after ${opts.frameWait}ms. ` +
          'Try --headful -v to watch it, --frame-selector to change the selector, or --game-url to skip detection.'
      );
    }

    log.info(`Extracted game source: ${found.src}`);
    log.debug(`(found in frame ${found.foundIn})`);
    return found.src;
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Step 2a: capture with the browser
// ---------------------------------------------------------------------------

/** Returns a (frame, url) => boolean telling whether a request belongs to the game. */
function makeGameMatcher(gameOrigin) {
  return (frame, url) => {
    if (originOf(url) === gameOrigin) return true;
    for (let f = frame; f; f = f.parentFrame()) {
      if (originOf(f.url()) === gameOrigin) return true; // requested by a page inside the game's iframe
    }
    return false;
  };
}

async function saveResponse(ctx, response, savedFiles) {
  const url = response.url();
  const status = response.status();

  if (status < 200 || status >= 300) {
    log.debug(`skip ${status} ${url}`);
    return;
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    return;
  }
  if (!/^https?:$/.test(parsed.protocol)) return;

  const skipReason = skipReasonFor(ctx.opts, parsed);
  if (skipReason) {
    log.debug(`skip (${skipReason}) ${url}`);
    return;
  }

  const rel = urlToRelativePath(url, ctx.sourceOrigin);
  const filepath = safeJoin(ctx.outDir, rel);
  if (!filepath) {
    log.warn(`Refusing to write outside output dir for ${url}`);
    return;
  }

  const queueForCurl = (why) => {
    if (!ctx.unreadable.some((item) => item.url === url)) ctx.unreadable.push({ url, rel, filepath });
    log.debug(`${why}: ${url}`);
  };

  // A 206 is a slice of the file (media Range requests); saving it would corrupt the file.
  if (status === 206) return queueForCurl('partial content (206), will download in full');

  let body;
  try {
    body = await response.buffer();
  } catch (err) {
    return queueForCurl(`body unreadable (${err.message})`);
  }
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, body);

  savedFiles.set(url, rel);
  recordFile(ctx, {
    url,
    path: rel,
    bytes: body.length,
    status,
    contentType: response.headers()['content-type'] || null,
    via: 'browser',
  });
  log.debug(`saved ${status} ${body.length}B ${url} -> ${rel}`);
}

/** Clicks and key presses to get past "tap to play" screens and trigger lazy loading of level assets. */
async function autoPlay(page, ctx) {
  const ms = ctx.opts.autoplay;
  const before = ctx.files.length;
  log.info(`Autoplay: clicking and pressing keys for ${ms}ms to get past menus (--autoplay 0 disables)`);

  let size = { w: 800, h: 600 };
  try {
    size = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  } catch (_) {
    /* keep default */
  }
  const spots = [[0.5, 0.5], [0.5, 0.65], [0.5, 0.8], [0.35, 0.5], [0.65, 0.5]];
  const keys = ['Space', 'Enter', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'ArrowDown'];

  const started = Date.now();
  let round = 0;
  while (Date.now() - started < ms) {
    const [fx, fy] = spots[round % spots.length];
    try {
      await page.mouse.click(Math.round(size.w * fx), Math.round(size.h * fy));
      await page.keyboard.press(keys[round % keys.length], { delay: 80 });
    } catch (err) {
      log.debug(`Autoplay input failed: ${err.message}`);
    }
    round += 1;
    await sleep(600);
  }
  log.info(`Autoplay: ${round} input round(s), ${ctx.files.length - before} new file(s) saved meanwhile`);
}

/** Resolves once the game has made requests and then gone quiet (or the load timeout passes). */
async function waitForGameIdle(ctx, state) {
  const { idle, loadTimeout } = ctx.opts;
  const started = Date.now();
  let lastReport = started;
  log.info(`Waiting for the game to load (done after ${idle}ms of no network activity, max ${loadTimeout}ms)`);

  while (Date.now() - started < loadTimeout) {
    const quiet = Date.now() - state.lastActivity;
    if (state.seen > 0 && state.inflight.size === 0 && quiet >= idle) {
      log.info(`Game is quiet: ${summarizeFiles(ctx.files)}`);
      return true;
    }
    if (Date.now() - lastReport >= 5000) {
      lastReport = Date.now();
      log.info(
        `  ...${state.seen} game request(s) so far, ${state.inflight.size} in flight, ` +
          `${ctx.files.length} file(s) saved`
      );
    }
    await sleep(250);
  }

  if (state.seen === 0) {
    log.warn('The game never made a request; is the iframe loading? Try --headful, --manual or --screenshot.');
  } else {
    log.warn(`Timed out after ${loadTimeout}ms while the game was still loading; saving what was captured`);
  }
  return false;
}

function waitForEnter(message) {
  return new Promise((resolve) => {
    console.log(message);
    process.stdin.resume();
    process.stdin.once('data', () => {
      process.stdin.pause();
      resolve();
    });
  });
}

async function clickIfPresent(page, selector) {
  try {
    await page.waitForSelector(selector, { timeout: 10000 });
    await page.click(selector);
    log.info(`Clicked ${selector}`);
  } catch (err) {
    log.warn(`Could not click ${selector}: ${err.message}`);
  }
}

/**
 * @param {{viaPage: boolean}} mode viaPage: load the embedding page and capture the game from its
 *   iframe; otherwise load the game URL directly.
 * @returns {Promise<boolean>} true on success, false if the curl fallback is needed
 */
async function captureWithBrowser(ctx, { viaPage }) {
  const { opts, sourceUrl } = ctx;
  const target = viaPage ? opts.pageUrl : sourceUrl;
  log.info(viaPage ? `Loading ${target} and capturing the game from its iframe` : `Loading ${target} directly`);

  const browser = await launchBrowser(opts);
  const pending = new Set();
  const flush = () => Promise.allSettled([...pending]);

  try {
    // Through the page the host sees a normal page load, so stay vanilla; direct loads keep the overrides.
    const page = await createPage(browser, opts, 'capture', { applyOverrides: !viaPage });
    const belongs = viaPage ? makeGameMatcher(ctx.sourceOrigin) : () => true;
    const state = { lastActivity: Date.now(), inflight: new Set(), seen: 0 };
    const savedFiles = new Map(); // absolute URL -> relative path

    // Clicks can open popups ("more games", ads); close them so the capture page keeps focus.
    browser.on('targetcreated', async (target) => {
      try {
        if (target.type() !== 'page' || !target.opener()) return;
        const popup = await target.page();
        if (popup) {
          log.debug(`Closing popup: ${popup.url()}`);
          await popup.close();
        }
      } catch (_) {
        /* already gone */
      }
    });

    page.on('request', (req) => {
      if (!belongs(req.frame(), req.url())) return;
      state.inflight.add(req);
      state.seen += 1;
      state.lastActivity = Date.now();
    });
    const settleRequest = (req) => {
      if (state.inflight.delete(req)) state.lastActivity = Date.now();
    };
    page.on('requestfinished', settleRequest);
    page.on('requestfailed', settleRequest);

    page.on('response', (response) => {
      if (!belongs(response.frame(), response.url())) return;
      state.lastActivity = Date.now();
      const task = saveResponse(ctx, response, savedFiles).catch((err) =>
        log.warn(`Failed to save ${response.url()}: ${err.message}`)
      );
      pending.add(task);
      task.finally(() => pending.delete(task));
    });

    let navigation = null;
    try {
      navigation = await page.goto(target, {
        waitUntil: viaPage ? 'domcontentloaded' : 'networkidle2',
        timeout: opts.timeout,
      });
    } catch (err) {
      if (viaPage || !String(err.message).includes('ERR_BLOCKED_BY_CLIENT')) throw err;
      log.warn('Direct load failed with ERR_BLOCKED_BY_CLIENT (the host refuses direct loads)');
    }

    if (!navigation || navigation.status() >= 400) {
      await flush();
      log.warn(`Browser navigation unusable (status: ${navigation ? navigation.status() : 'none'})`);
      return false;
    }
    log.debug(`Navigation OK: HTTP ${navigation.status()}`);

    if (viaPage) {
      if (opts.click) await clickIfPresent(page, opts.click);
      await waitForGameIdle(ctx, state);
      if (opts.autoplay > 0 && !opts.manual) {
        await autoPlay(page, ctx);
        await waitForGameIdle(ctx, state);
      }
    }
    if (opts.manual) {
      await waitForEnter(
        '\nThe browser is open. Play the game to load more of its assets (levels, sounds, skins...).\n' +
          'Press Enter here when you are done...'
      );
    }

    log.debug(`Settling for ${opts.settle}ms`);
    await sleep(opts.settle);
    await flush();
    retryUnreadable(ctx, savedFiles);
    log.info(`Captured ${summarizeFiles(ctx.files)}`);

    if (opts.screenshot) {
      const shot = path.join(ctx.outDir, '_screenshot.png');
      await page.screenshot({ path: shot });
      log.info(`Saved screenshot: ${shot}`);
    }

    // The raw game page was saved with the rest; if not, fall back to the live DOM.
    const pageRel = urlToRelativePath(sourceUrl, ctx.sourceOrigin);
    const rawPath = safeJoin(ctx.outDir, pageRel);
    let fallbackHtml = null;
    if (!rawPath || !fs.existsSync(rawPath)) {
      log.warn('The raw game page was not captured; using the live DOM instead');
      const frame = viaPage ? page.frames().find((f) => originOf(f.url()) === ctx.sourceOrigin) : page.mainFrame();
      fallbackHtml = frame ? await frame.content() : null;
    }

    if (ctx.files.length === 0) return false;
    finalizePage(ctx, fallbackHtml);
    return true;
  } finally {
    await flush();
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Step 2b: curl
// ---------------------------------------------------------------------------

/** Referer a real browser would send: the game page for its own files, the game origin for others. */
function refererFor(ctx, url) {
  if (ctx.opts.explicit.referer) return ctx.opts.referer;
  return new URL(url).origin === ctx.sourceOrigin ? ctx.sourceUrl : `${ctx.sourceOrigin}/`;
}

/** One-line explanation when every failure has the same cause. */
function failureHint(failures) {
  const all = (re) => failures.length > 0 && failures.every((f) => re.test(f.reason));
  if (all(/\b40[13]\b/)) {
    return 'Every download was refused (HTTP 401/403): the server is rejecting curl, probably because it only ' +
      'serves these files to a real browser session. Capture through the page instead (give <page-url>, no --curl-only).';
  }
  if (all(/\b404\b/)) {
    return 'Every download was a 404: the files are not where the script is looking. Capture through the page ' +
      'instead (give <page-url>, no --curl-only), or pass real paths with --asset (relative to the game directory).';
  }
  if (all(/\(6\)|\(7\)|\(28\)|timed out/i)) {
    return 'Every download failed at the network level (DNS / connection / timeout), not with an HTTP error.';
  }
  return null;
}

/** Browser mode: responses whose bodies could not be used directly (partial 206s, large files evicted from Chrome's cache). */
function retryUnreadable(ctx, savedFiles) {
  if (!ctx.unreadable.length) return;
  log.warn(
    `${ctx.unreadable.length} response(s) could not be saved straight from the browser ` +
      '(partial content or unreadable bodies); downloading them with curl'
  );
  try {
    assertCurlAvailable();
  } catch (err) {
    log.warn(err.message);
    return;
  }
  for (const item of ctx.unreadable) {
    try {
      const bytes = curlDownload(ctx.opts, item.url, item.filepath, refererFor(ctx, item.url));
      savedFiles.set(item.url, item.rel);
      recordFile(ctx, { url: item.url, path: item.rel, bytes, via: 'curl-retry' });
    } catch (err) {
      log.warn(`  still failed: ${item.url} (${err.message.split('\n')[0]})`);
    }
  }
  ctx.unreadable.length = 0;
}

function assertCurlAvailable() {
  try {
    execFileSync('curl', ['--version'], { stdio: 'ignore' });
  } catch (_) {
    throw new Error('curl is required for the fallback path but was not found on PATH');
  }
}

/** Downloads url to filepath. Throws with curl's stderr on failure. Returns bytes written. */
function curlDownload(opts, url, filepath, referer = opts.referer) {
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  const args = [
    '--location',
    '--fail',
    '--silent',
    '--show-error',
    '--proto', '=http,https',
    '--proto-redir', '=http,https',
    '--max-time', String(Math.max(1, Math.ceil(opts.timeout / 1000))),
    '--user-agent', opts.userAgent,
    '--referer', referer,
    '--output', filepath,
    url,
  ];

  const t0 = Date.now();
  log.debug(`curl GET ${url} (referer: ${referer})`);
  try {
    execFileSync('curl', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    fs.rmSync(filepath, { force: true });
    const stderr = err.stderr ? err.stderr.toString().trim() : '';
    throw new Error(stderr || err.message);
  }

  const bytes = fs.statSync(filepath).size;
  log.debug(`curl ok ${bytes}B in ${Date.now() - t0}ms ${url}`);
  return bytes;
}

function saveWithCurl(ctx) {
  const { opts, sourceUrl } = ctx;
  log.info(`Capturing ${sourceUrl} with curl (only finds files named in the HTML)`);
  assertCurlAvailable();

  const source = new URL(sourceUrl);
  const baseDir = new URL('.', source).href; // directory containing the game's index
  const indexUrl = source.origin + source.pathname;
  const pageRel = urlToRelativePath(sourceUrl, ctx.sourceOrigin);
  const indexPath = safeJoin(ctx.outDir, pageRel);

  // Mimic a browser: the index is requested from the embedding page (origin-only Referer),
  // the game's own files are requested by the game page itself.
  const pageOrigin = opts.pageUrl ? new URL(opts.pageUrl).origin : ctx.sourceOrigin;
  const indexReferer = opts.explicit.referer ? opts.referer : `${pageOrigin}/`;

  log.debug(`Index URL: ${indexUrl} (query string dropped), saved as ${pageRel}, base dir: ${baseDir}`);
  const indexBytes = curlDownload(opts, indexUrl, indexPath, indexReferer);
  recordFile(ctx, { url: indexUrl, path: pageRel, bytes: indexBytes, via: 'curl' });

  const html = fs.readFileSync(indexPath, 'utf8');

  const targets = extractUrlsFromHtml(html, indexUrl);
  log.debug(`Found ${targets.size} URL(s) referenced by the HTML`);
  for (const asset of opts.coreAssets) targets.add(new URL(asset, baseDir).href);
  for (const url of [...targets]) {
    const reason = skipReasonFor(opts, new URL(url));
    if (reason) {
      targets.delete(url);
      log.debug(`skip (${reason}) ${url}`);
    }
  }
  log.info(`Downloading ${targets.size} file(s)`);

  let ok = 0;
  const failures = [];
  const resolvedIndex = path.resolve(indexPath);

  for (const url of targets) {
    const rel = urlToRelativePath(url, ctx.sourceOrigin);
    const filepath = safeJoin(ctx.outDir, rel);
    if (!filepath) {
      log.debug(`skip (unsafe path) ${url}`);
      continue;
    }
    if (filepath === resolvedIndex) {
      log.debug(`skip (the page itself) ${url}`);
      continue;
    }
    try {
      const bytes = curlDownload(opts, url, filepath, refererFor(ctx, url));
      recordFile(ctx, { url, path: rel, bytes, via: 'curl' });
      ok += 1;
    } catch (err) {
      failures.push({ url, reason: err.message.split('\n')[0] });
    }
  }

  log.info(`curl finished: ${ok} downloaded, ${failures.length} failed`);
  if (failures.length) {
    log.warn(`${failures.length} download(s) failed:`);
    for (const f of failures.slice(0, 10)) log.warn(`  ${f.url}\n      ${f.reason}`);
    if (failures.length > 10) log.warn(`  ... and ${failures.length - 10} more`);
    const hint = failureHint(failures);
    if (hint) log.warn(hint);
  }

  finalizePage(ctx, null);
}

// ---------------------------------------------------------------------------
// Serving a saved folder
// ---------------------------------------------------------------------------

/** Static server for a saved folder: correct MIME types, Range requests, every 404 logged. */
function startServer(opts) {
  const http = require('http');
  const root = opts.serveDir;
  if ((!opts.serveLibrary && !fs.existsSync(root)) || (fs.existsSync(root) && !fs.statSync(root).isDirectory())) {
    return Promise.reject(new Error(`Not a directory: ${root}`));
  }

  const server = http.createServer((req, res) => {
    const reply = (status, headers, body) => {
      res.writeHead(status, headers);
      res.end(body);
    };

    let pathname;
    try {
      pathname = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
    } catch (_) {
      return reply(400, { 'Content-Type': 'text/plain' }, 'Bad request');
    }

    if (opts.serveLibrary && (pathname === '/' || pathname === '/index.html')) {
      const body = renderGameLibrary(root);
      const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };
      if (opts.isolate) {
        headers['Cross-Origin-Opener-Policy'] = 'same-origin';
        headers['Cross-Origin-Embedder-Policy'] = 'credentialless';
      }
      headers['Content-Length'] = Buffer.byteLength(body);
      res.writeHead(200, headers);
      return req.method === 'HEAD' ? res.end() : res.end(body);
    }

    const rel = pathname.replace(/^\/+/, '');
    let file = rel ? safeJoin(root, rel) : path.join(root, 'index.html');
    if (!file) {
      log.warn(`403 ${req.url}`);
      return reply(403, { 'Content-Type': 'text/plain' }, 'Forbidden');
    }
    try {
      if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    } catch (_) {
      /* reported as 404 below */
    }

    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) {
        log.warn(`404 ${req.url}`);
        return reply(404, { 'Content-Type': 'text/plain' }, 'Not found');
      }

      const headers = {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      };
      if (opts.isolate) {
        headers['Cross-Origin-Opener-Policy'] = 'same-origin';
        headers['Cross-Origin-Embedder-Policy'] = 'credentialless';
      }

      let status = 200;
      let start = 0;
      let end = stat.size - 1;
      const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range.trim());
      if (range && (range[1] || range[2]) && stat.size > 0) {
        if (range[1] === '') {
          start = Math.max(0, stat.size - Number(range[2])); // suffix range: the last N bytes
        } else {
          start = Number(range[1]);
          if (range[2]) end = Math.min(end, Number(range[2]));
        }
        if (start > end || start >= stat.size) {
          log.debug(`416 ${req.url} (${req.headers.range})`);
          return reply(416, { 'Content-Range': `bytes */${stat.size}` }, '');
        }
        status = 206;
        headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
      }

      headers['Content-Length'] = stat.size === 0 ? 0 : end - start + 1;
      log.debug(`${status} ${req.method} ${req.url}`);
      res.writeHead(status, headers);
      if (req.method === 'HEAD' || stat.size === 0) return res.end();
      fs.createReadStream(file, { start, end })
        .on('error', () => res.destroy())
        .pipe(res);
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => {
      log.info(`Serving ${root} at http://localhost:${opts.port}/ (Ctrl+C to stop)`);
      if (opts.isolate) log.info('Cross-origin isolation headers (COOP/COEP) are on');
      resolve(server);
    });
  });
}

function renderGameLibrary(root) {
  const games = fs.existsSync(root)
    ? fs.readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && isGameName(entry.name))
        .filter((entry) => fs.existsSync(path.join(root, entry.name, 'index.html')))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b))
    : [];
  const cards = games
    .map((game) => `<a class="game" href="/${encodeURIComponent(game)}/"><span>${game}</span><span aria-hidden="true">Play &rarr;</span></a>`)
    .join('\n');
  const content = games.length
    ? `<nav class="games" aria-label="Saved games">${cards}</nav>`
    : '<p class="empty">No saved games yet. Capture a game with <code>pokisave &lt;game-name&gt;</code> and it will appear here.</p>';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PokiSave - Your games</title>
  <style>
    :root { color-scheme: dark; font-family: system-ui, sans-serif; background: #10131b; color: #f5f6fa; }
    body { box-sizing: border-box; max-width: 900px; margin: 0 auto; padding: 48px 24px; }
    h1 { margin: 0; font-size: clamp(2rem, 6vw, 3.5rem); }
    .subtitle { color: #a7adbd; margin: 8px 0 32px; }
    .games { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; }
    .game { display: flex; justify-content: space-between; gap: 16px; padding: 20px; border: 1px solid #303747; border-radius: 12px; color: inherit; text-decoration: none; background: #191e29; }
    .game:hover, .game:focus-visible { border-color: #9c7cff; background: #22283a; }
    .game span:last-child { color: #b6a1ff; }
    .empty { color: #a7adbd; padding: 20px; border: 1px dashed #454d5e; border-radius: 12px; }
    code { color: #d3c7ff; }
  </style>
</head>
<body>
  <h1>PokiSave</h1>
  <p class="subtitle">Your saved games, ready to play offline.</p>
  ${content}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseCli(process.argv.slice(2));
  currentLevel = opts.logLevel;
  log.debug('Options:', opts);

  if (opts.serveDir) {
    await startServer(opts);
    return; // keep running until Ctrl+C
  }

  fs.mkdirSync(opts.outDir, { recursive: true });

  let sourceUrl = opts.gameUrl;
  if (sourceUrl) {
    log.info(`Using provided game URL: ${sourceUrl}`);
  } else {
    sourceUrl = await extractGameUrl(opts);
  }

  const ctx = {
    opts,
    sourceUrl,
    sourceOrigin: new URL(sourceUrl).origin,
    outDir: opts.outDir,
    files: [],
    pathOwners: new Map(),
    unreadable: [],
  };

  // With a page URL, load the game through its real iframe (direct loads are usually blocked).
  const viaPage = Boolean(opts.pageUrl) && !opts.direct;
  let mode = viaPage ? 'page' : 'direct';
  let captured = false;
  if (!opts.curlOnly) captured = await captureWithBrowser(ctx, { viaPage });

  if (!captured) {
    if (opts.noFallback) throw new Error('Browser capture failed and --no-fallback was set');
    if (!opts.curlOnly) log.warn('Falling back to curl');
    mode = 'curl';
    saveWithCurl(ctx);
  }

  if (opts.manifest) writeManifest(ctx, mode);

  const assetCount = ctx.files.filter((f) => !/\.html?$/i.test(f.path)).length;
  if (assetCount === 0) {
    throw new Error(
      'Only the HTML page was saved; none of the game files were captured, so the page will sit on its loading ' +
        'screen. See the warnings above (add -v for per-file detail).'
    );
  }
  log.info(`Done (${mode}): ${summarizeFiles(ctx.files)} saved to ${opts.outDir}`);
  log.info(`Play it offline:  pokisave --serve "${opts.outDir}"   then open http://localhost:8000/`);
  log.info('Stuck on a menu offline? Re-run with --manual and play a level; every 404 the server logs is a missing file.');
}

if (require.main === module) {
  main().catch((err) => {
    log.error(err.message);
    if (currentLevel >= LEVELS.debug) console.error(err.stack);
    process.exitCode = 1;
  });
}

module.exports = {
  urlToRelativePath, toHref, relHref, safeJoin, stripPokiSdk, extractUrlsFromHtml, findGameFrame, describePage,
  refererFor, failureHint, verifyLocalRefs, retryUnreadable, makeGameMatcher, finalizePage, summarizeFiles,
  writeOutputPage, saveResponse, autoPlay, diagnoseSaved, startServer, skipReasonFor,
  parseCli, isGameName, gameNameFromUrl, OFFLINE_SHIM_JS, POKI_SDK_STUB_JS,
};