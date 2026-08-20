#!/usr/bin/env node
/**
 * aeropush — minimal CLI (pre-@aeropush/cli).
 *
 *   aeropush bundle    Build release JS bundles for iOS/Android and zip each
 *                      into an upload-ready archive (platform bundle at the zip
 *                      root, assets alongside) — the layout the SDK's sync
 *                      pipeline expects.
 *
 *   aeropush release   Build (as above) AND publish each zip to an AeroPush
 *                      server via `POST /v1/api/release` (app-key auth). This
 *                      is the real OTA push path — the dashboard then serves
 *                      the bundle to devices through signed links.
 *
 * Zero dependencies — Node built-ins + the host app's own react-native CLI.
 * `release` uses the global fetch/FormData/Blob, so it needs Node 18+.
 * The full CLI (login/fingerprint/rollback, §12 of OTA.md) lands in Phase 4 as
 * @aeropush/cli.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { zipDirectory } = require('./zip');
const { computeNativeFingerprint, embedFingerprint } = require('./fingerprint');

// ─── Quiet bundling: hide Metro's logo + warnings, show a spinner ─────────────

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Run the bundle command with its output captured (not shown). A spinner runs
 * while it works. Metro's logo, warnings and progress noise stay hidden on
 * success; the full captured output is dumped only if the build FAILS, so
 * errors are never swallowed.
 */
function runQuietly(cmd, cliArgs, cwd, label) {
  return new Promise((resolve) => {
    const child = spawn(cmd, cliArgs, { cwd, stdio: ['inherit', 'pipe', 'pipe'] });
    let buf = '';
    child.stdout.on('data', (d) => (buf += d));
    child.stderr.on('data', (d) => (buf += d));
    let i = 0;
    const D = '\x1b[2m';
    const R = '\x1b[0m';
    const tty = process.stdout.isTTY;
    // Animate a spinner on a TTY; on a pipe/CI just print the label once.
    if (!tty) process.stdout.write(`  ${label}\n`);
    const spin = tty
      ? setInterval(() => {
          process.stdout.write(`\r  ${SPINNER[i++ % SPINNER.length]} ${D}${label}${R}`);
        }, 80)
      : null;
    const stop = (code) => {
      if (spin) clearInterval(spin);
      if (tty) process.stdout.write('\r\x1b[K'); // clear the spinner line
      if (code !== 0) process.stderr.write(buf); // surface output only on failure
      resolve(code ?? 1);
    };
    child.on('close', stop);
    child.on('error', () => stop(1));
  });
}

// ─── Big block-logo release banner ───────────────────────────────────────────

const LOGO_FONT = {
  A: [' ███ ', '█   █', '█████', '█   █', '█   █'],
  E: ['█████', '█    ', '████ ', '█    ', '█████'],
  R: ['████ ', '█   █', '████ ', '█  █ ', '█   █'],
  O: [' ███ ', '█   █', '█   █', '█   █', ' ███ '],
  P: ['████ ', '█   █', '████ ', '█    ', '█    '],
  U: ['█   █', '█   █', '█   █', '█   █', ' ███ '],
  S: [' ████', '█    ', ' ███ ', '    █', '████ '],
  H: ['█   █', '█   █', '█████', '█   █', '█   █'],
};

function renderLogo(text) {
  const rows = ['', '', '', '', ''];
  for (const ch of text.toUpperCase()) {
    const g = LOGO_FONT[ch] || ['     ', '     ', '     ', '     ', '     '];
    for (let i = 0; i < 5; i++) rows[i] += g[i] + ' ';
  }
  return rows;
}

function readProjectInfo(appRoot, args) {
  let name = '', version = '';
  try {
    const aj = JSON.parse(fs.readFileSync(path.join(appRoot, 'app.json'), 'utf8'));
    name = aj.displayName || aj.name || '';
  } catch {}
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
    if (!name) name = pj.name || '';
    version = pj.version || '';
  } catch {}
  const platform =
    args.platforms.length === 2
      ? 'iOS + Android'
      : args.platforms[0] === 'ios'
        ? 'iOS'
        : 'Android';
  const env = args.channel.charAt(0).toUpperCase() + args.channel.slice(1);
  return { name: name || 'App', version: version || '—', platform, env };
}

function printReleaseBanner(info) {
  const W = '\x1b[1m\x1b[97m'; // bold bright white
  const D = '\x1b[2m';
  const R = '\x1b[0m';
  const out = process.stdout;
  out.write('\n');
  for (const row of renderLogo('AEROPUSH')) out.write('  ' + W + row + R + '\n');
  out.write('\n  AeroPush — React Native OTA Platform\n\n');
  const rows = [
    ['Project', info.name],
    ['Platform', info.platform],
    ['Version', info.version],
    ['Environment', info.env],
  ];
  for (const [k, v] of rows) out.write(`  ✓ ${k.padEnd(13)}${D}${v}${R}\n`);
  out.write('\n');
}

// ─── Upload progress bar ─────────────────────────────────────────────────────

function drawBar(pct) {
  const width = 34;
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  let bar = '█'.repeat(filled);
  if (filled < width) bar += '▓' + '░'.repeat(width - filled - 1);
  process.stdout.write(`\r  ${bar}  ${String(Math.round(pct)).padStart(2)}%`);
}

/** Show an animated bar while `task` runs; completes to 100% on success. */
async function withProgress(label, task) {
  process.stdout.write(`  → ${label}\n`);
  let pct = 0;
  const timer = setInterval(() => {
    pct = Math.min(pct + 7, 92);
    drawBar(pct);
  }, 100);
  try {
    const result = await task;
    clearInterval(timer);
    drawBar(100);
    process.stdout.write('\n');
    return result;
  } catch (e) {
    clearInterval(timer);
    process.stdout.write('\n');
    throw e;
  }
}

const PLATFORMS = {
  ios: { bundleName: 'main.jsbundle', zipName: 'ios.zip' },
  android: { bundleName: 'index.android.bundle', zipName: 'android.zip' },
};

const DEFAULT_SERVER = process.env.AEROPUSH_SERVER || 'https://aeropush.tech';

function usage() {
  console.log(`
aeropush — OTA bundle builder + publisher for react-native-aeropush

Usage:
  aeropush bundle      [options]   Build release bundles + zips (no upload)
  aeropush release     [options]   Build + publish to the AeroPush server
  aeropush fingerprint [embed]     Print the native fingerprint, or embed it
                                   into ios/Info.plist + android/build.gradle

Build options (both commands):
  --platform <ios|android>       One platform only (default: both)
  --entry <file>                 Entry file (default: index.js)
  --out <dir>                    Output directory (default: aeropush-dist)
  --sourcemaps                   Also emit .map files next to the zips

Release options (release only):
  --app-key <key>                App key from the dashboard  [required]
                                 (or set AEROPUSH_APP_KEY)
  --server <url>                 AeroPush base URL
                                 (default: ${DEFAULT_SERVER}; or AEROPUSH_SERVER)
  --channel <name>               Channel to publish to (default: production)
  --notes <text>                 Release notes
  --fingerprint <value>          Override the native fingerprint (default: it is
                                 auto-computed from your native dependency set)
  --no-fingerprint               Publish untagged (universal) — advanced/legacy
  --target <range>               Target native range, e.g. ">=1.2.0 <2.0.0"
  --rollout <1-100>              Staged rollout percentage (default: 100)
  --mandatory                    Mark the release mandatory
  --force                        Force past a fingerprint mismatch (crash risk)

Examples:
  aeropush fingerprint                 # print the current native fingerprint
  aeropush fingerprint embed           # bake it into the native projects, then rebuild
  aeropush bundle --platform ios
  AEROPUSH_APP_KEY=apk_live_xxx aeropush release --platform ios --notes "Fix checkout"
`);
}

function parseArgs(argv) {
  const args = {
    platforms: Object.keys(PLATFORMS),
    entry: 'index.js',
    out: 'aeropush-dist',
    sourcemaps: false,
    // release-only
    appKey: process.env.AEROPUSH_APP_KEY || '',
    server: DEFAULT_SERVER,
    channel: 'production',
    notes: '',
    fingerprint: '',
    target: '',
    rollout: 100,
    mandatory: false,
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--platform') {
      const p = argv[++i];
      if (!PLATFORMS[p]) fail(`unknown platform "${p}" (expected ios or android)`);
      args.platforms = [p];
    } else if (a === '--entry') {
      args.entry = argv[++i];
    } else if (a === '--out') {
      args.out = argv[++i];
    } else if (a === '--sourcemaps') {
      args.sourcemaps = true;
    } else if (a === '--app-key') {
      args.appKey = argv[++i];
    } else if (a === '--server') {
      args.server = argv[++i];
    } else if (a === '--channel') {
      args.channel = argv[++i];
    } else if (a === '--notes') {
      args.notes = argv[++i];
    } else if (a === '--fingerprint') {
      args.fingerprint = argv[++i];
    } else if (a === '--no-fingerprint') {
      args.noFingerprint = true;
    } else if (a === '--target') {
      args.target = argv[++i];
    } else if (a === '--rollout') {
      args.rollout = parseInt(argv[++i], 10);
      if (!(args.rollout >= 1 && args.rollout <= 100)) fail('--rollout must be 1-100');
    } else if (a === '--mandatory') {
      args.mandatory = true;
    } else if (a === '--force') {
      args.force = true;
    } else if (a === '--help' || a === '-h') {
      usage();
      process.exit(0);
    } else {
      fail(`unknown option "${a}" (see aeropush --help)`);
    }
  }
  return args;
}

function fail(msg) {
  console.error(`\n✗ aeropush: ${msg}\n`);
  process.exit(1);
}

/**
 * Normalise a configured base URL to the `…/v1/api` REST base the backend
 * serves. Accepts the origin, `…/v1`, or the full `…/v1/api` (mirrors the SDK's
 * resolveApiBase so the CLI, SDK and dashboard agree on one URL shape).
 */
function resolveApiBase(serverUrl) {
  const trimmed = String(serverUrl || '').replace(/\/+$/, '');
  if (/\/v1\/api$/.test(trimmed)) return trimmed;
  if (/\/v1$/.test(trimmed)) return `${trimmed}/api`;
  return `${trimmed}/v1/api`;
}

function findReactNativeCli(appRoot) {
  // Resolve the host app's own react-native CLI so we build with the exact
  // Metro version the app uses.
  try {
    const pkgPath = require.resolve('react-native/package.json', { paths: [appRoot] });
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin['react-native'] || pkg.bin.rn || Object.values(pkg.bin)[0];
    return path.join(path.dirname(pkgPath), bin);
  } catch {
    fail('react-native not found — run this from your app root (where package.json lives)');
  }
}

async function buildPlatform(appRoot, cli, platform, args) {
  const { bundleName, zipName } = PLATFORMS[platform];
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), `aeropush-${platform}-`));
  const bundleOut = path.join(staging, bundleName);
  const mapOut = path.join(appRoot, args.out, `${platform}.jsbundle.map`);

  const cliArgs = [
    cli,
    'bundle',
    '--platform', platform,
    '--dev', 'false',
    '--entry-file', args.entry,
    '--bundle-output', bundleOut,
    '--assets-dest', staging,
    '--reset-cache',
  ];
  if (args.sourcemaps) {
    fs.mkdirSync(path.dirname(mapOut), { recursive: true });
    cliArgs.push('--sourcemap-output', mapOut);
  }

  const code = await runQuietly(process.execPath, cliArgs, appRoot, `Bundling ${platform} (release)…`);
  if (code !== 0) fail(`[${platform}] react-native bundle failed (exit ${code})`);
  if (!fs.existsSync(bundleOut)) fail(`[${platform}] expected bundle at ${bundleOut} but it was not produced`);

  const zipPath = path.join(appRoot, args.out, zipName);
  const { files, bytes } = zipDirectory(staging, zipPath);
  fs.rmSync(staging, { recursive: true, force: true });

  const mb = (bytes / (1024 * 1024)).toFixed(2);
  console.log(`✓ [${platform}] ${path.relative(appRoot, zipPath)}  (${files} file${files === 1 ? '' : 's'}, ${mb} MB)`);
  return zipPath;
}

/** Publish a built zip to the AeroPush server via POST /v1/api/release. */
async function uploadRelease(zipPath, platform, args) {
  if (typeof fetch === 'undefined' || typeof FormData === 'undefined') {
    fail('release needs Node 18+ (global fetch/FormData). Upgrade Node, or use `aeropush bundle` and upload from CI.');
  }
  const url = `${resolveApiBase(args.server)}/release`;
  const buf = fs.readFileSync(zipPath);

  const form = new FormData();
  form.append('platform', platform);
  form.append('channel', args.channel);
  form.append('rollout_percentage', String(args.rollout));
  form.append('is_mandatory', String(args.mandatory));
  form.append('force_push', String(args.force));
  if (args.notes) form.append('release_notes', args.notes);
  if (args.fingerprint) form.append('native_fingerprint', args.fingerprint);
  if (args.target) form.append('target_range', args.target);
  form.append('bundle', new Blob([buf], { type: 'application/zip' }), 'bundle.zip');

  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'X-App-Key': args.appKey }, body: form });
  } catch (e) {
    fail(`[${platform}] network error reaching ${url}: ${e.message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text).error || text; } catch {}
    fail(`[${platform}] publish failed (HTTP ${res.status}): ${msg}`);
  }
  return JSON.parse(text);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') {
    usage();
    process.exit(command ? 0 : 1);
  }
  const KNOWN = ['bundle', 'release', 'fingerprint'];
  if (!KNOWN.includes(command)) {
    fail(`unknown command "${command}" (expected ${KNOWN.join(', ')})`);
  }

  const appRoot = process.cwd();

  // ── fingerprint [embed|--value] ─────────────────────────────────────────
  if (command === 'fingerprint') {
    const { fingerprint, natives } = computeNativeFingerprint(appRoot);
    // Machine-readable: print ONLY the value (for build-system hooks).
    if (rest.includes('--value')) {
      process.stdout.write(fingerprint);
      return;
    }
    if (rest[0] === 'embed') {
      const res = embedFingerprint(appRoot, fingerprint);
      console.log(`\nNative fingerprint: ${fingerprint}`);
      console.log(`  iOS      ${res.ios.ok ? '✓ ' + res.ios.msg : '✗ ' + res.ios.msg}`);
      console.log(`  Android  ${res.android.ok ? '✓ ' + res.android.msg : '✗ ' + res.android.msg}`);
      console.log('\nRebuild the binary for the change to take effect.\n');
    } else {
      console.log(`\nNative fingerprint: ${fingerprint}`);
      console.log(`Computed from ${natives.length} native package${natives.length === 1 ? '' : 's'}:`);
      for (const n of natives) console.log(`  - ${n}`);
      console.log(`\nBake it in with:  aeropush fingerprint embed\n`);
    }
    return;
  }

  const args = parseArgs(rest);
  if (!fs.existsSync(path.join(appRoot, args.entry))) {
    fail(`entry file "${args.entry}" not found in ${appRoot} — run from your app root or pass --entry`);
  }
  if (command === 'release' && !args.appKey) {
    fail('release needs an app key — pass --app-key or set AEROPUSH_APP_KEY');
  }

  // The full block-logo banner up front for a release.
  if (command === 'release') {
    printReleaseBanner(readProjectInfo(appRoot, args));
  }

  // Auto-tag the release with the current native fingerprint unless the
  // developer overrode it or explicitly opted out. This is what keeps an old
  // binary from ever receiving a bundle built against different native code.
  if (command === 'release' && !args.fingerprint && !args.noFingerprint) {
    args.fingerprint = computeNativeFingerprint(appRoot).fingerprint;
    console.log(`  ${'\x1b[2m'}native fingerprint (auto): ${args.fingerprint}${'\x1b[0m'}\n`);
  }

  const cli = findReactNativeCli(appRoot);
  const zips = [];
  for (const p of args.platforms) {
    zips.push([p, await buildPlatform(appRoot, cli, p, args)]);
  }

  if (command === 'bundle') {
    console.log(`\nDone. Publish with:  aeropush release --app-key <key>`);
    console.log(`(or POST each zip to ${resolveApiBase(args.server)}/release with an X-App-Key header)\n`);
    return;
  }

  // command === 'release' — upload each platform with a progress bar
  const published = [];
  for (const [platform, zipPath] of zips) {
    const data = await withProgress(
      `Uploading ${platform} bundle...`,
      uploadRelease(zipPath, platform, args)
    );
    published.push([platform, data.version ?? data.release?.version]);
  }
  process.stdout.write('\n');
  for (const [platform, v] of published) {
    console.log(`  \x1b[38;5;114m✓\x1b[0m ${platform} · v${v} published`);
  }
  console.log(`\n  🚀 Ready to deploy  ${'\x1b[2m'}· ${String(args.server).replace(/\/+$/, '')}/v1/dashboard${'\x1b[0m'}\n`);
}

main().catch((e) => fail(e && e.message ? e.message : String(e)));
