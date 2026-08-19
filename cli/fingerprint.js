'use strict';

/**
 * Native fingerprint — a deterministic hash of the app's NATIVE dependency set.
 *
 * Only packages that ship native code (an `ios/` or `android/` dir, or a
 * `.podspec`) affect the compiled binary, so only those are hashed — plus their
 * resolved versions. Pure-JS packages change freely via OTA and are ignored.
 *
 * The same value is baked into the binary (`fingerprint embed`) and attached to
 * each bundle (`release`), so the server can keep an old binary from ever
 * receiving a bundle built against a different native footprint. Add or remove a
 * native library and the hash changes by itself — no manual tokens.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

function hasNativeCode(pkgDir) {
  try {
    if (fs.existsSync(path.join(pkgDir, 'android'))) return true;
    if (fs.existsSync(path.join(pkgDir, 'ios'))) return true;
    return fs.readdirSync(pkgDir).some((f) => f.endsWith('.podspec'));
  } catch {
    return false;
  }
}

function readVersion(pkgDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version || '';
  } catch {
    return '';
  }
}

/** Returns { fingerprint: "sha256:…", natives: ["name@version", …] }. */
function computeNativeFingerprint(appRoot) {
  const nm = path.join(appRoot, 'node_modules');
  let entries;
  try {
    entries = fs.readdirSync(nm, { withFileTypes: true });
  } catch {
    throw new Error('node_modules not found — run from your app root after `npm install`');
  }

  const natives = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    if (e.name.startsWith('@')) {
      let sub = [];
      try {
        sub = fs.readdirSync(path.join(nm, e.name), { withFileTypes: true });
      } catch {}
      for (const s of sub) {
        if (!s.isDirectory()) continue;
        const dir = path.join(nm, e.name, s.name);
        if (hasNativeCode(dir)) natives.push(`${e.name}/${s.name}@${readVersion(dir)}`);
      }
    } else {
      const dir = path.join(nm, e.name);
      if (hasNativeCode(dir)) natives.push(`${e.name}@${readVersion(dir)}`);
    }
  }

  natives.sort();
  const hash = crypto.createHash('sha256').update(JSON.stringify(natives)).digest('hex');
  return { fingerprint: `sha256:${hash}`, natives };
}

// ─── Embedding into the native projects ──────────────────────────────────────

function findInfoPlist(iosDir) {
  const found = [];
  (function walk(d) {
    let items;
    try {
      items = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      if (it.name === 'Pods' || it.name === 'build' || it.name.startsWith('.')) continue;
      const p = path.join(d, it.name);
      if (it.isDirectory()) walk(p);
      else if (it.name === 'Info.plist' && !/Tests/i.test(p)) found.push(p);
    }
  })(iosDir);
  // shallowest path first — the app target's Info.plist
  found.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length);
  return found[0] || null;
}

function embedIOS(appRoot, fp) {
  const iosDir = path.join(appRoot, 'ios');
  if (!fs.existsSync(iosDir)) return { ok: false, msg: 'no ios/ directory (skipped)' };
  const plist = findInfoPlist(iosDir);
  if (!plist) return { ok: false, msg: 'no Info.plist found under ios/' };

  const key = 'AeroPushNativeFingerprint';
  let r = spawnSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${fp}`, plist]);
  if (r.status !== 0) {
    r = spawnSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${fp}`, plist]);
  }
  if (r.status !== 0) {
    return { ok: false, msg: `PlistBuddy failed: ${String(r.stderr || '').trim()}` };
  }
  return { ok: true, msg: path.relative(appRoot, plist) };
}

function embedAndroid(appRoot, fp) {
  const gradle = path.join(appRoot, 'android', 'app', 'build.gradle');
  if (!fs.existsSync(gradle)) return { ok: false, msg: 'no android/app/build.gradle (skipped)' };

  let src = fs.readFileSync(gradle, 'utf8');
  const field = `buildConfigField "String", "AEROPUSH_NATIVE_FINGERPRINT", '"${fp}"'`;

  if (/AEROPUSH_NATIVE_FINGERPRINT/.test(src)) {
    src = src.replace(
      /buildConfigField\s+"String",\s*"AEROPUSH_NATIVE_FINGERPRINT",\s*'".*?"'/,
      field
    );
  } else if (/defaultConfig\s*\{/.test(src)) {
    src = src.replace(/(defaultConfig\s*\{)/, `$1\n        ${field}`);
  } else {
    return { ok: false, msg: 'could not find defaultConfig block in build.gradle' };
  }

  // AGP 8+ needs the buildConfig feature enabled for custom fields.
  if (!/buildConfig\s+true/.test(src)) {
    src = src.replace(/(android\s*\{)/, `$1\n    buildFeatures {\n        buildConfig true\n    }`);
  }

  fs.writeFileSync(gradle, src);
  return { ok: true, msg: 'android/app/build.gradle' };
}

/** Compute (if needed) and write the fingerprint into both native projects. */
function embedFingerprint(appRoot, fp) {
  const value = fp || computeNativeFingerprint(appRoot).fingerprint;
  return { fingerprint: value, ios: embedIOS(appRoot, value), android: embedAndroid(appRoot, value) };
}

module.exports = { computeNativeFingerprint, embedFingerprint };
