// Timing and concurrency helpers.

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Runs fn(item) for every item, `limit` at a time.
export async function pool(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
