/** Read every page from a stable, caller-owned query. Read-only helpers only. */
export async function fetchAllPages(fetchPage, { pageSize = 200 } = {}) {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new TypeError('pageSize must be a positive integer');
  const rows = [];
  let from = 0;
  while (true) {
    const page = await fetchPage(from, from + pageSize - 1);
    if (!Array.isArray(page)) throw new TypeError('fetchPage must return an array');
    rows.push(...page);
    if (page.length < pageSize) return rows;
    from += page.length;
  }
}

/** Keep PostgREST `in` filters bounded; caller still paginates each chunk. */
export function chunkValues(values, size = 100) {
  if (!Number.isInteger(size) || size < 1) throw new TypeError('size must be a positive integer');
  const chunks = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}
