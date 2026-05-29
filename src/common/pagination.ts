/** Cursor-based pagination helpers (conventions §6). Cursors are opaque to
 * clients and encode (createdAt, id) for stable keyset pagination. */

export interface PageInfo {
  nextCursor: string | null;
  hasNextPage: boolean;
}

export interface Page<T> {
  data: T[];
  pageInfo: PageInfo;
}

export interface DecodedCursor {
  createdAt: Date;
  id: string;
}

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

export function clampLimit(limit?: number): number {
  if (!limit || limit < 1) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}

export function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ c: row.createdAt.toISOString(), i: row.id })).toString(
    'base64url',
  );
}

export function decodeCursor(cursor?: string): DecodedCursor | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed.c !== 'string' || typeof parsed.i !== 'string') return undefined;
    return { createdAt: new Date(parsed.c), id: parsed.i };
  } catch {
    return undefined;
  }
}

/** Given limit+1 rows, split off the page and compute pageInfo. */
export function buildPage<T extends { createdAt: Date; id: string }>(
  rows: T[],
  limit: number,
): Page<T> {
  const hasNextPage = rows.length > limit;
  const data = hasNextPage ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];
  return {
    data,
    pageInfo: {
      hasNextPage,
      nextCursor: hasNextPage && last ? encodeCursor(last) : null,
    },
  };
}
