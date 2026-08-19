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
const { spawnSync } = require('child_process');
const { zipDirectory } = require('./zip');
const { computeNativeFingerprint, embedFingerprint } = require('./fingerprint');

const PLATFORMS = {
  ios: { bundleName: 'main.jsbundle', zipName: 'ios.zip' },
  android: { bundleName: 'index.android.bundle', zipName: 'android.zip' },
};

const DEFAULT_SERVER = process.env.AEROPUSH_SERVER || 'https://ota.cavyiot.com';

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

function buildPlatform(appRoot, cli, platform, args) {
  const { bundleName, zipName } = PLATFORMS[platform];
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), `aeropush-${platform}-`));
  const bundleOut = path.join(staging, bundleName);
  const mapOut = path.join(appRoot, args.out, `${platform}.jsbundle.map`);

  console.log(`\n▸ [${platform}] bundling (release, --dev false)…`);
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

  const res = spawnSync(process.execPath, cliArgs, { cwd: appRoot, stdio: 'inherit' });
  if (res.status !== 0) fail(`[${platform}] react-native bundle failed (exit ${res.status})`);
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

  console.log(`\n▸ [${platform}] publishing to ${url} (channel ${args.channel})…`);
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
  const data = JSON.parse(text);
  console.log(`✓ [${platform}] published v${data.version ?? data.release?.version}  (${data.checksum ?? ''})`);
  return data;
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

  // Auto-tag the release with the current native fingerprint unless the
  // developer overrode it or explicitly opted out. This is what keeps an old
  // binary from ever receiving a bundle built against different native code.
  if (command === 'release' && !args.fingerprint && !args.noFingerprint) {
    args.fingerprint = computeNativeFingerprint(appRoot).fingerprint;
    console.log(`▸ native fingerprint (auto): ${args.fingerprint}`);
    console.log(`  (make sure your binary was built after \`aeropush fingerprint embed\`)`);
  }

  const cli = findReactNativeCli(appRoot);
  const zips = args.platforms.map((p) => [p, buildPlatform(appRoot, cli, p, args)]);

  if (command === 'bundle') {
    console.log(`\nDone. Publish with:  aeropush release --app-key <key>`);
    console.log(`(or POST each zip to ${resolveApiBase(args.server)}/release with an X-App-Key header)\n`);
    return;
  }

  // command === 'release'
  for (const [platform, zipPath] of zips) {
    await uploadRelease(zipPath, platform, args);
  }
  console.log(`\n✓ All done. View the release in the dashboard: ${String(args.server).replace(/\/+$/, '')}/v1/dashboard\n`);
}

main().catch((e) => fail(e && e.message ? e.message : String(e)));
