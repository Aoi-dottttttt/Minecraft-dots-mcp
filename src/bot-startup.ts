import type { Bot } from 'mineflayer';

/** Call synchronously after createBot, before the first await. Mineflayer's
 * earlier inject_allowed listener installs all queued plugins synchronously. */
export function waitForNativePlugins(bot: Bot, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      bot.removeListener('inject_allowed', injected);
      bot.removeListener('end', ended);
      bot.removeListener('kicked', kicked);
      bot.removeListener('error', failed);
      options.signal?.removeEventListener('abort', aborted);
      error ? reject(error) : resolve();
    };
    const injected = (): void => finish();
    const ended = (): void => finish(new Error('Minecraft session ended before native plugin initialization'));
    const kicked = (): void => finish(new Error('Minecraft session was kicked before native plugin initialization'));
    const failed = (error: Error): void => finish(new Error('Minecraft native plugin initialization failed', { cause: error }));
    const aborted = (): void => finish(new Error('Minecraft native plugin initialization cancelled'));
    const timer = setTimeout(() => finish(new Error('Minecraft native plugin initialization timed out')), options.timeoutMs ?? 30_000);
    bot.once('inject_allowed', injected);
    bot.once('end', ended);
    bot.once('kicked', kicked);
    bot.once('error', failed);
    options.signal?.addEventListener('abort', aborted, { once: true });
    if (options.signal?.aborted) aborted();
  });
}
