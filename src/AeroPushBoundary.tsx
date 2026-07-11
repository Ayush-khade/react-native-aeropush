import React from 'react';
import Native from './NativeAeropush';

/**
 * AeroPushBoundary — Layer 3 of the crash-guard stack.
 * -----------------------------------------------------
 * Wrap your app root in this. It catches errors thrown during React rendering
 * (which the global JS handler in Layer 2 does not reliably intercept) and
 * routes them to the same native "mark this bundle failed" path so the next
 * launch triggers an auto-rollback.
 *
 *   import { AeroPushBoundary } from 'react-native-aeropush';
 *
 *   export default function App() {
 *     return (
 *       <AeroPushBoundary>
 *         <RealApp />
 *       </AeroPushBoundary>
 *     );
 *   }
 *
 * Provide a `fallback` to control what the user sees while the bad bundle is
 * still live (until they relaunch and get rolled back). Keep the fallback
 * dead simple — it must not depend on any app code that might also be broken.
 */

export interface AeroPushBoundaryProps {
  children: React.ReactNode;
  /** Rendered after a caught render error. Keep it self-contained. */
  fallback?: React.ReactNode;
  /** Optional hook so the host app can log/report the error too. */
  onError?: (error: Error, info: { componentStack: string }) => void;
}

interface AeroPushBoundaryState {
  hasError: boolean;
}

export class AeroPushBoundary extends React.Component<
  AeroPushBoundaryProps,
  AeroPushBoundaryState
> {
  state: AeroPushBoundaryState = { hasError: false };

  static getDerivedStateFromError(): AeroPushBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(
    error: Error,
    info: { componentStack: string },
  ): void {
    // Only trigger rollback machinery when we're on an OTA bundle; a render
    // crash in the binary bundle is the developer's own bug, not ours to
    // roll back (there's nothing safer to roll back to).
    if (Native.isRunningBundle()) {
      void Native.markBundleFailed(error.message);
    }
    this.props.onError?.(error, info);
  }

  componentDidMount(): void {
    // A clean mount is our strongest signal the bundle is healthy. If we got
    // here without throwing, clear the native crash counter.
    if (!this.state.hasError) {
      void Native.markBundleHealthy();
    }
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      return this.props.fallback ?? null;
    }
    return this.props.children;
  }
}
