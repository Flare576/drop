# Drop Relay — pull-side web UI

Static, vanilla HTML/CSS/JS (ES modules, no bundler, no framework) that a locked-down client
VDI's browser loads to pull encrypted code artifacts, decrypt them client-side, and save the
result to local disk. Push (the coding-harness side) is handled elsewhere (`cli/`); this
directory is read/decrypt/delete only.

## Files

- `index.html` — login form + artifact list markup.
- `app.js` — all app logic (login, list, download, decrypt, delete). ES module, imported by
  `index.html` via `<script type="module">`.
- `crypto.js` — the crypto module. See "Why crypto.js is a copy, not an import" below.
- `style.css` — minimal dark/light theme, no dependencies.

## Why `crypto.js` is a copy, not a live import of `../shared/crypto.ts`

The assignment's preference was a direct ES module import of `shared/crypto.ts`. That does
not work unmodified in a plain browser: `shared/crypto.ts` contains TypeScript syntax
(`interface`, parameter/return type annotations, an `as unknown as number[]` cast) that
browsers cannot parse — `<script type="module">` only executes JavaScript, and no browser
strips TS types at runtime. Loading it directly throws a `SyntaxError` on the `interface`
declaration before any code runs. This was confirmed by attempting the import; the alternative
(a build step to transpile TS to JS) is explicitly out of scope per the "no bundler/framework"
constraint.

So `web/crypto.js` is a byte-for-byte logical port of `shared/crypto.ts` with only the
TypeScript type annotations removed — same salt (`rp-vdi-relay-drop-the-mic`), same
`ID_PLAINTEXT`, same PBKDF2 iteration count (310,000), same AES-GCM-256 parameters, same
chunked base64 encoding. This is the same pattern already used in the sibling `mylibrary`
project (`js/crypto.js`, ported from `ei`'s TS source) — precedent for "copy + strip types"
over "reinvent" when a TS module needs to run in a plain browser.

**If `shared/crypto.ts` ever changes, port the change here too** — `generateUserId` must stay
byte-identical to what `cli/` (the push side) computes, or the two sides derive different
mailbox IDs for the same credentials and nothing will ever show up in the list.

## Configuring the API base

`index.html` sets `window.DROP_API_BASE` before `app.js` loads, defaulting to the production
relay (`https://flare576.com/drop/api`). It can be overridden per-page-load via a query
string, with no code changes and nothing to persist:

```
index.html?apiBase=http://localhost:8080/drop/api
```

This is not a secret — it's just a URL — so a query param is fine; it deliberately does not
use `localStorage`/`sessionStorage` for consistency with the credential-handling rule below.

## Local testing

ES modules (`<script type="module">`) refuse to load over `file://` (browsers block
cross-origin module fetches from the file scheme), so you need a local HTTP server — no
build step, any static server works:

```sh
cd web
python3 -m http.server 8080
# open http://localhost:8080/
```

By default the page will hit the **production** API (`https://flare576.com/drop/api`), which
is safe to use for testing — CORS is wildcard-open there and you're only ever pushing/pulling
your own encrypted mailbox. Requires a real push (e.g. via `cli/`) to have something to list.

To test against a local copy of `api/` instead (needs its own MySQL DB + `api/config.php`
generated from `api/config.php.template` — see `api/README.md`), run it with PHP's built-in
server from the repo root, routing every request through `index.php` (it hardcodes
`/drop/api/` as its expected base path, so the router and the `apiBase` query param both
need that prefix):

```sh
cd api
php -S localhost:8081 index.php
# then open http://localhost:8080/?apiBase=http://localhost:8081/drop/api
```

### What was verified while building this

- Login form renders and `generateUserId()` derives a deterministic userId from
  username+passphrase, calling the list endpoint on submit — checked directly in a
  headless browser.
- Full encrypt → decrypt round trip against ciphertext **not** produced by this UI: a
  throwaway script imported `../shared/crypto.ts` directly under Bun (which runs TS
  natively) to independently derive a userId and encrypt a `{filename, patch}` payload.
  That `{iv, ciphertext}` was served to the real `index.html`/`app.js`/`crypto.js` running
  in a headless browser (via a local mock of the list/get/delete endpoints), which
  downloaded, decrypted, and saved a file to disk whose contents were byte-for-byte
  identical to the original plaintext produced by the independent script.
- Empty list, 404 (expired/already-consumed artifact), and network-unreachable-server cases
  all render a visible, non-generic status message — no silent failures.
- Captured every network request made by the page (list, get-one, delete) and confirmed
  none contain the username or passphrase in any URL, header, or body — only the derived
  userId (in the path) and, for downloads, the artifactId.

## Credential handling

`username`/`passphrase` are held in a single module-scope variable in `app.js` for the
lifetime of the page and are **never** written to `localStorage` or `sessionStorage`. A page
reload requires signing in again — this is intentional, not a bug, and matches the VDI threat
model (nothing about the credentials should survive the browser tab). The passphrase `<input>`
is cleared immediately after a successful `generateUserId()` call so it doesn't linger in the
DOM either.
