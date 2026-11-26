# PokiSave

PokiSave captures a Poki game and its runtime assets so you can play the saved copy offline.

## Install

Requires Node.js 22.12 or newer. Once published, install globally from npm:

```sh
npm install --global pokisave
```

To install directly from a checkout, run this in the project directory:

```sh
npm install --global .
```

Puppeteer downloads a compatible browser during installation. `curl` is also required for
fallback capture and `--curl-only` mode.

The `pokisave` package is prepared for npm but has not been published yet. After publication,
you can also run it without a global install using `npx pokisave`.

## Usage

Capture a Poki game by its slug or page URL:

```sh
pokisave drive-mad
pokisave https://poki.com/en/g/stickman-hook --manual
```

Serve a saved game locally:

```sh
pokisave serve
pokisave serve --game drive-mad
```

`pokisave serve` opens a local library at <http://localhost:8000/> with links to saved games
inside `./games`. Use `-g` or `--game` to serve one saved game directly. You can also keep using
`--serve <directory>` to serve any specific folder:

```sh
pokisave --serve games/drive-mad
```

The library page can install a new game by Poki slug or game-page URL. New installs and updates
save a local screenshot for the game card; older saves without one show a generated placeholder.

Update saved games from Poki:

```sh
pokisave update
pokisave update --game drive-mad
```

The game library page also has buttons to update an individual game or all saved games.

Then open <http://localhost:8000/> and leave the server running while you play. Do not open the
saved `index.html` directly (`file://`): games that load WebAssembly, workers, or other local
resources need to be served over HTTP.

Use `pokisave --help` or `pokisave serve --help` for all capture and serving options.

## Development

```sh
npm install
npm link
pokisave --help
```
