// Turns one auction snapshot into per-item price statistics (ST-1).

export interface Listing {
  id: number;
  itemId: number;
  /** Buyout per unit in copper; null for bid-only auctions. */
  unitPrice: number | null;
  quantity: number;
  timeLeft: string | null;
}

export interface ItemStats {
  itemId: number;
  minBuyout: number | null;
  /** Average unit cost of buying the cheapest `batch` units, or all stock if fewer. */
  price20: number | null;
  p10: number | null;
  p25: number | null;
  p50: number | null;
  /** All units listed, including bid-only. */
  quantity: number;
  listings: number;
}

export const DEFAULT_BATCH = 20;

/** Quantity-weighted percentile over listings sorted by unit price. */
function weightedPercentile(sorted: Listing[], totalQty: number, pct: number): number | null {
  if (totalQty === 0) return null;
  const target = Math.max(1, Math.ceil(totalQty * pct));
  let seen = 0;
  for (const l of sorted) {
    seen += l.quantity;
    if (seen >= target) return l.unitPrice;
  }
  return sorted.at(-1)?.unitPrice ?? null;
}

function costOfCheapest(sorted: Listing[], units: number): number | null {
  let bought = 0;
  let cost = 0;
  for (const l of sorted) {
    const take = Math.min(l.quantity, units - bought);
    cost += take * (l.unitPrice as number);
    bought += take;
    if (bought >= units) break;
  }
  return bought === 0 ? null : Math.round(cost / bought);
}

export function aggregate(listings: Listing[], batch = DEFAULT_BATCH): ItemStats[] {
  const byItem = new Map<number, Listing[]>();
  for (const l of listings) {
    if (l.quantity <= 0) continue;
    let bucket = byItem.get(l.itemId);
    if (!bucket) byItem.set(l.itemId, (bucket = []));
    bucket.push(l);
  }

  const out: ItemStats[] = [];
  for (const [itemId, all] of byItem) {
    const buyable = all
      .filter((l) => l.unitPrice !== null && l.unitPrice > 0)
      .sort((a, b) => (a.unitPrice as number) - (b.unitPrice as number));
    const buyableQty = buyable.reduce((s, l) => s + l.quantity, 0);
    out.push({
      itemId,
      minBuyout: buyable[0]?.unitPrice ?? null,
      price20: costOfCheapest(buyable, batch),
      p10: weightedPercentile(buyable, buyableQty, 0.1),
      p25: weightedPercentile(buyable, buyableQty, 0.25),
      p50: weightedPercentile(buyable, buyableQty, 0.5),
      quantity: all.reduce((s, l) => s + l.quantity, 0),
      listings: all.length,
    });
  }
  return out.sort((a, b) => a.itemId - b.itemId);
}
