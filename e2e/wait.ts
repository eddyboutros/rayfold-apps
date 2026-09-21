/**
 * Bounded waits, so a missed signal fails a test rather than hanging it.
 *
 * Nothing here sleeps for a fixed time: a test that waits 500ms for a relay measures the machine it runs on. These
 * resolve the moment the condition holds and fail with what they were waiting for.
 */
export async function until<T>(what: string, check: () => Promise<T | undefined> | T | undefined, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const value = await check();
      if (value !== undefined && value !== null && value !== false) return value as T;
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline) {
      throw new Error(`still waiting for ${what} after ${timeoutMs}ms${last ? `; last error: ${String(last)}` : ""}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** A signal something happened, with a bounded wait for it. */
export function signal<T>(): { fire: (value: T) => void; wait: (what: string, timeoutMs?: number) => Promise<T> } {
  const seen: T[] = [];
  return {
    fire: (value) => seen.push(value),
    wait: (what, timeoutMs = 5_000) => until(what, () => seen.shift(), timeoutMs),
  };
}
