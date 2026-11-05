/**
 * Run at most `max` tasks at once, queueing the rest in call order. Shared by
 * the diagram renderers (mermaid.ts, typst.ts), each of which builds one per
 * document render.
 *
 * A finishing task hands its slot straight to the next waiter rather than
 * releasing it: resolving a promise only schedules a microtask, so between
 * `waiting.shift()` and the woken caller resuming there is a gap in which a
 * freshly arriving caller would see a free slot that is already spoken for
 * and push `active` past `max`.
 */
export function createLimiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];

  return async function run<T>(task: () => Promise<T>): Promise<T> {
    // Claim the slot before yielding, or queue for one that is handed over.
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;

    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}
