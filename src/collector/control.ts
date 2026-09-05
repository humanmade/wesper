import { CollectionTransportError, UsageError, type CollectOptions } from '../types.js';

export const DEFAULT_COLLECTION_TIMEOUT_MS = 30_000;

export interface CollectionControl {
  signal: AbortSignal;
  dispose(): void;
  throwIfAborted(): void;
}

/** Combine cancellation sources without depending on newer AbortSignal APIs. */
export function combineAbortSignals(signals: readonly AbortSignal[]): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const listeners = new Map<AbortSignal, () => void>();
  const abort = (source: AbortSignal): void => {
    if (!controller.signal.aborted) controller.abort(source.reason);
  };
  for (const signal of signals) {
    if (signal.aborted) {
      abort(signal);
      break;
    }
    const listener = () => abort(signal);
    listeners.set(signal, listener);
    signal.addEventListener('abort', listener, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener);
      listeners.clear();
    },
  };
}

/** Make the caller's cancellation signal and a single collection deadline one signal. */
export function collectionControl(options: CollectOptions): CollectionControl {
  const timeoutMs = options.timeoutMs ?? DEFAULT_COLLECTION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new UsageError('--timeout-ms must be a positive integer.');
  }
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort('deadline'), timeoutMs);
  const combined = options.signal ? combineAbortSignals([options.signal, deadline.signal]) : undefined;
  const signal = combined?.signal ?? deadline.signal;
  return {
    signal,
    dispose: () => {
      clearTimeout(timer);
      combined?.dispose();
    },
    throwIfAborted: () => {
      if (!signal.aborted) return;
      throw new CollectionTransportError(
        deadline.signal.aborted ? 'Collection deadline exceeded.' : 'Collection was cancelled.',
        deadline.signal.aborted ? 'deadline_exceeded' : 'cancelled',
      );
    },
  };
}
