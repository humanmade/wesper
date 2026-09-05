import { CollectionTransportError, UsageError, type CollectOptions } from '../types.js';

export const DEFAULT_COLLECTION_TIMEOUT_MS = 30_000;

export interface CollectionControl {
  signal: AbortSignal;
  dispose(): void;
  throwIfAborted(): void;
}

/** Make the caller's cancellation signal and a single collection deadline one signal. */
export function collectionControl(options: CollectOptions): CollectionControl {
  const timeoutMs = options.timeoutMs ?? DEFAULT_COLLECTION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new UsageError('--timeout-ms must be a positive integer.');
  }
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort('deadline'), timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  return {
    signal,
    dispose: () => clearTimeout(timer),
    throwIfAborted: () => {
      if (!signal.aborted) return;
      throw new CollectionTransportError(
        deadline.signal.aborted ? 'Collection deadline exceeded.' : 'Collection was cancelled.',
        deadline.signal.aborted ? 'deadline_exceeded' : 'cancelled',
      );
    },
  };
}
