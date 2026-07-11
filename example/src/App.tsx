import React, { useEffect, useState, useCallback } from 'react';
import {
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useColorScheme,
} from 'react-native';

import AeroPush, {
  AeroPushBoundary,
  InstallMode,
  SyncStatus,
  type UpdateInfo,
} from 'react-native-aeropush';

// ─── Initialise the SDK once, before the component tree renders ────────────
// In a real app you'd pass your dashboard-issued appKey here.
AeroPush.init({
  appKey: 'demo-app-key',
  channel: 'production',
  // serverUrl defaults to the hosted service; the demo uses a hardcoded
  // check inside the SDK so this app runs without any backend.
});

interface LogLine {
  id: number;
  text: string;
  kind: 'info' | 'ok' | 'err' | 'progress';
}

let logCounter = 0;

function AppInner(): React.JSX.Element {
  const isDark = useColorScheme() === 'dark';
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [version, setVersion] = useState<number>(0);
  const [fingerprint, setFingerprint] = useState<string>('');
  const [running, setRunning] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);

  const log = useCallback((text: string, kind: LogLine['kind'] = 'info') => {
    setLogs((prev) => [{ id: ++logCounter, text, kind }, ...prev].slice(0, 60));
  }, []);

  // On mount: read current state + mark this bundle healthy (clears the
  // native crash counter so we don't roll back a working build).
  useEffect(() => {
    (async () => {
      const v = await AeroPush.getCurrentVersion();
      setVersion(v);
      const fp = AeroPush.unstable_native.getNativeFingerprint();
      setFingerprint(fp || '(none embedded)');
      const isOta = AeroPush.unstable_native.isRunningBundle();
      setRunning(isOta);
      log(`Booted. version=${v}  ota=${isOta}`, 'info');

      // Confirm health once we've successfully rendered.
      await AeroPush.markBundleHealthy();
      log('markBundleHealthy() → crash counter reset', 'ok');
    })();
  }, [log]);

  const onCheckAndSync = useCallback(async () => {
    setBusy(true);
    log('sync() started…', 'info');
    const status = await AeroPush.sync({
      installMode: InstallMode.ON_NEXT_RESTART,
      onUpdateAvailable: (u: UpdateInfo) => {
        log(`Update available: v${u.version} — ${u.releaseNotes}`, 'info');
      },
      onProgress: (received: number, total: number) => {
        const pct = total > 0 ? Math.round((received / total) * 100) : 0;
        log(`Downloading… ${pct}% (${received}/${total} bytes)`, 'progress');
      },
      onUpToDate: () => log('Already up to date.', 'ok'),
      onError: (e: Error) => log(`Error: ${e.message}`, 'err'),
    });

    switch (status) {
      case SyncStatus.UPDATE_INSTALLED_PENDING_RESTART:
        log('Update staged — will apply on next launch.', 'ok');
        break;
      case SyncStatus.UPDATE_INSTALLED:
        log('Update installed & applied.', 'ok');
        break;
      case SyncStatus.UP_TO_DATE:
        log('sync() → UP_TO_DATE', 'ok');
        break;
      case SyncStatus.ERROR:
        log('sync() → ERROR (see above)', 'err');
        break;
    }
    setBusy(false);
  }, [log]);

  const onApplyNow = useCallback(() => {
    log('restart() → reloading JS runtime…', 'info');
    AeroPush.restart();
  }, [log]);

  const onRollback = useCallback(async () => {
    await AeroPush.rollback();
    log('rollback() → cleared active bundle. Restart to take effect.', 'ok');
  }, [log]);

  const onSimulateCrash = useCallback(async () => {
    // Demonstrates Layer 2/3 → native counter. Marks the bundle failed so the
    // NEXT launch auto-rolls back. (We don't actually crash the demo.)
    await AeroPush.unstable_native.markBundleFailed('manual test from demo');
    const count = await AeroPush.unstable_native.getLaunchFailureCount();
    log(`markBundleFailed() → failure count now ${count}`, 'err');
    log('Next cold start will auto-roll back.', 'info');
  }, [log]);

  const bg = isDark ? '#0b0f14' : '#f5f7fa';
  const card = isDark ? '#131a22' : '#ffffff';
  const fg = isDark ? '#e6edf3' : '#1a2028';
  const sub = isDark ? '#8b98a5' : '#5a6672';

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: bg }]}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={[styles.title, { color: fg }]}>AeroPush Demo</Text>
        <Text style={[styles.subtitle, { color: sub }]}>
          Zero-dependency OTA · Turbo Module
        </Text>

        <View style={[styles.statusCard, { backgroundColor: card }]}>
          <Row label="Bundle version" value={`v${version}`} fg={fg} sub={sub} />
          <Row
            label="Running OTA bundle"
            value={running ? 'yes' : 'no (binary)'}
            fg={fg}
            sub={sub}
          />
          <Row label="Native fingerprint" value={fingerprint} fg={fg} sub={sub} />
        </View>

        <Btn label={busy ? 'Working…' : 'Check for update & sync'} onPress={onCheckAndSync} disabled={busy} primary />
        <Btn label="Apply now (restart)" onPress={onApplyNow} />
        <Btn label="Rollback" onPress={onRollback} />
        <Btn label="Simulate bad bundle (mark failed)" onPress={onSimulateCrash} danger />

        <Text style={[styles.logHeader, { color: sub }]}>Activity log</Text>
        <View style={[styles.logCard, { backgroundColor: card }]}>
          {logs.length === 0 ? (
            <Text style={[styles.logEmpty, { color: sub }]}>No activity yet.</Text>
          ) : (
            logs.map((l) => (
              <Text key={l.id} style={[styles.logLine, { color: colorFor(l.kind, fg) }]}>
                {prefixFor(l.kind)} {l.text}
              </Text>
            ))
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({
  label,
  value,
  fg,
  sub,
}: {
  label: string;
  value: string;
  fg: string;
  sub: string;
}): React.JSX.Element {
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, { color: sub }]}>{label}</Text>
      <Text style={[styles.rowValue, { color: fg }]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function Btn({
  label,
  onPress,
  primary,
  danger,
  disabled,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
}): React.JSX.Element {
  const bg = danger ? '#b3261e' : primary ? '#2563eb' : '#334155';
  return (
    <TouchableOpacity
      style={[styles.btn, { backgroundColor: bg, opacity: disabled ? 0.5 : 1 }]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.8}>
      <Text style={styles.btnText}>{label}</Text>
    </TouchableOpacity>
  );
}

function colorFor(kind: LogLine['kind'], fg: string): string {
  switch (kind) {
    case 'ok':
      return '#22c55e';
    case 'err':
      return '#ef4444';
    case 'progress':
      return '#eab308';
    default:
      return fg;
  }
}

function prefixFor(kind: LogLine['kind']): string {
  switch (kind) {
    case 'ok':
      return '✓';
    case 'err':
      return '✗';
    case 'progress':
      return '↓';
    default:
      return '•';
  }
}

// ─── Wrap the app in AeroPushBoundary (Layer 3 crash detection) ────────────
export default function App(): React.JSX.Element {
  return (
    <AeroPushBoundary
      fallback={
        <SafeAreaView style={styles.fallback}>
          <Text style={styles.fallbackText}>
            Something went wrong. Restart to recover.
          </Text>
        </SafeAreaView>
      }>
      <AppInner />
    </AeroPushBoundary>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  scroll: { padding: 20 },
  title: { fontSize: 28, fontWeight: '700', marginTop: 8 },
  subtitle: { fontSize: 14, marginBottom: 20 },
  statusCard: { borderRadius: 14, padding: 16, marginBottom: 20 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 },
  rowLabel: { fontSize: 14 },
  rowValue: { fontSize: 14, fontWeight: '600', maxWidth: '60%' },
  btn: { borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginBottom: 12 },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  logHeader: { fontSize: 13, fontWeight: '600', marginTop: 12, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
  logCard: { borderRadius: 14, padding: 14, minHeight: 120 },
  logEmpty: { fontSize: 13, fontStyle: 'italic' },
  logLine: { fontSize: 12, fontFamily: 'Menlo', marginBottom: 4, lineHeight: 16 },
  fallback: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0b0f14' },
  fallbackText: { color: '#e6edf3', fontSize: 16, padding: 24, textAlign: 'center' },
});
