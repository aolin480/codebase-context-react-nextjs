/**
 * Controls how large `.codebase-index.json` is allowed to be (in bytes) before we skip
 * parsing it for `get_codebase_metadata` statistics.
 *
 * NOTE: This is ONLY for metadata/statistics enrichment. Search uses the index independently.
 */

const DEFAULT_MAX_MB = 20;

export function getIndexStatsMaxBytes(): number {
  const raw = process.env.CODEBASE_CONTEXT_INDEX_STATS_MAX_MB;

  // Allow disabling stats parsing entirely by setting 0 or a negative value.
  if (raw != null && raw.trim() !== "") {
    const mb = Number.parseInt(raw, 10);
    if (!Number.isFinite(mb) || Number.isNaN(mb)) {
      return DEFAULT_MAX_MB * 1024 * 1024;
    }
    if (mb <= 0) return 0;
    return mb * 1024 * 1024;
  }

  return DEFAULT_MAX_MB * 1024 * 1024;
}
