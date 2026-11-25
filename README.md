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

Then open <http://localhost:8000/>.

Use `pokisave --help` or `pokisave serve --help` for all capture and serving options.

## Development

```sh
npm install
npm link
pokisave --help
```
