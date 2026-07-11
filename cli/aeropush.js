#!/usr/bin/env node
/**
 * aeropush — minimal CLI (pre-@aeropush/cli).
 *
 * `aeropush bundle` builds release JS bundles for iOS and Android from the
 * host app and zips each into an upload-ready archive whose layout matches
 * what the SDK's sync pipeline expects (platform bundle at the zip root,
 * assets alongside).
 *
 * Zero dependencies — Node built-ins + the host app's own react-native CLI.
 * The full CLI (login/release/fingerprint/rollback, §12 of OTA.md) lands in
 * Phase 4 as @aeropush/cli; this exists so production OTA delivery can be
 * tested before the backend exists.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { zipDirectory } = require('./zip');

const PLATFORMS = {
  ios: { bundleName: 'main.jsbundle', zipName: 'ios.zip' },
  android: { bundleName: 'index.android.bundle', zipName: 'android.zip' },
};

function usage() {
  console.log(`
aeropush — OTA bundle builder for react-native-aeropush

Usage:
  aeropush bundle [options]     Build release bundles + zips for upload

Options:
  --platform <ios|android>      Build one platform only (default: both)
  --entry <file>                Entry file (default: index.js)
  --out <dir>                   Output directory (default: aeropush-dist)
  --sourcemaps                  Also emit .map files next to the zips

Output:
  <out>/ios.zip        contains main.jsbundle (+ assets)
  <out>/android.zip    contains index.android.bundle (+ assets)

Upload each zip to your bundle host, e.g.:
  https://ota.cavyiot.com/bundles/ios.zip
  https://ota.cavyiot.com/bundles/android.zip
`);
}

function parseArgs(argv) {
  const args = { platforms: Object.keys(PLATFORMS), entry: 'index.js', out: 'aeropush-dist', sourcemaps: false };
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

function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') {
    usage();
    process.exit(command ? 0 : 1);
  }
  if (command !== 'bundle') fail(`unknown command "${command}" (only "bundle" exists for now)`);

  const args = parseArgs(rest);
  const appRoot = process.cwd();
  if (!fs.existsSync(path.join(appRoot, args.entry))) {
    fail(`entry file "${args.entry}" not found in ${appRoot} — run from your app root or pass --entry`);
  }
  const cli = findReactNativeCli(appRoot);

  const zips = args.platforms.map((p) => buildPlatform(appRoot, cli, p, args));

  console.log(`\nDone. Upload to your bundle host, e.g.:`);
  for (const z of zips) {
    console.log(`  ${path.basename(z)}  →  https://ota.cavyiot.com/bundles/${path.basename(z)}`);
  }
  console.log('');
}

main();
