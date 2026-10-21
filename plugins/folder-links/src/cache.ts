// Remembers an answer for a short time, so a burst of questions (every link in
// a message, every click in the tree) asks the source once. Calls made while
// the source answers share the one question; a failed question is not
// remembered — the previous answer, or `fallback`, stands in for it.

export function cachedFor<T>(
  find: () => Promise<T>,
  ttlMs: number,
  fallback: T,
  now: () => number = Date.now,
): () => Promise<T> {
  let current: { at: number; value: Promise<T> } | undefined;
  let lastGood: T = fallback;
  return () => {
    if (current === undefined || now() - current.at > ttlMs) {
      const value = find().then(
        (answer) => (lastGood = answer),
        () => lastGood,
      );
      current = { at: now(), value };
    }
    return current.value;
  };
}
