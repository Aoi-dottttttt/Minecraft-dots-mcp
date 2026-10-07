/** An operation opts into automatic defense interruption only while doing
 * navigation, timed controls or digging, never while submitting inventory or
 * placement effects. The scope is released after the real operation settles. */
export type InterruptibleOptions = { signal?: AbortSignal; enterInterruptible?: () => () => void };
export async function interruptible<T>(options: InterruptibleOptions, operation: () => Promise<T>): Promise<T> {
  const release = options.enterInterruptible?.();
  try { options.signal?.throwIfAborted(); return await operation(); }
  finally { release?.(); }
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: unknown): void => { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (error) reject(error); else resolve(); };
    const abort = (): void => finish(signal?.reason ?? new Error('Movement cancelled'));
    const timer = setTimeout(() => finish(), ms);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
