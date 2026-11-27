// Icon names (and fallback names/quality) for items, from Wowhead's public tooltip service: the same
// endpoint its embeddable tooltip script uses. Looked up only for items about to be shown, cached in the
// item table, and re-checked at most weekly, so request volume stays small.
import type { DatabaseSync } from "node:sqlite";

type Db = DatabaseSync;

/** Wowhead data sets to try: 16 knows Forever-only items, 4 is Classic Era, 0 is the default. */
const DATA_ENVS = [16, 4, 0];
const RECHECK_SECONDS = 7 * 86400;
const MAX_LOOKUPS_PER_CALL = 60;
const CONCURRENCY = 4;

interface Tooltip { name?: string; quality?: number; icon?: string }

async function fetchTooltip(itemId: number, fetchImpl: typeof fetch): Promise<Tooltip | null> {
  for (const env of DATA_ENVS) {
    try {
      const res = await fetchImpl(`https://nether.wowhead.com/tooltip/item/${itemId}${env ? `?dataEnv=${env}` : ""}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const t = (await res.json()) as Tooltip;
      if (t.icon) return t;
    } catch { /* try the next data set */ }
  }
  return null;
}

/**
 * Fills icon names for the given items where missing (at most MAX_LOOKUPS_PER_CALL per call), using a
 * writable connection. Returns how many were looked up.
 */
export async function ensureIcons(db: Db, itemIds: number[], fetchImpl: typeof fetch = fetch): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const need = itemIds.filter((id) => {
    const row = db.prepare("SELECT icon_name, wowhead_checked_at FROM item WHERE item_id = ?").get(id) as
      | { icon_name: string | null; wowhead_checked_at: number | null } | undefined;
    return !row?.icon_name && (!row?.wowhead_checked_at || now - row.wowhead_checked_at > RECHECK_SECONDS);
  }).slice(0, MAX_LOOKUPS_PER_CALL);

  const save = db.prepare(
    `INSERT INTO item (item_id, name, name_source, updated_at, quality, icon_name, wowhead_checked_at)
     VALUES (:id, :name, 'wowhead', :now, :quality, :icon, :now)
     ON CONFLICT (item_id) DO UPDATE SET
       icon_name = coalesce(excluded.icon_name, item.icon_name),
       quality = coalesce(item.quality, excluded.quality),
       name = coalesce(item.name, excluded.name),
       name_source = CASE WHEN item.name IS NULL AND excluded.name IS NOT NULL THEN 'wowhead' ELSE item.name_source END,
       wowhead_checked_at = excluded.wowhead_checked_at`,
  );
  let next = 0;
  const worker = async () => {
    while (next < need.length) {
      const id = need[next++] as number;
      const t = await fetchTooltip(id, fetchImpl);
      save.run({ id, now, name: t?.name ?? null, quality: t?.quality ?? null, icon: t?.icon ?? null });
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return need.length;
}
