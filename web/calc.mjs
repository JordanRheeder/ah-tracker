// Profit calculator maths, shared by the dashboard (web/app.js) and the tests (test/calc.test.ts).
// All amounts are copper. Deposits are paid when listing, refunded when the item sells and lost when
// the listing expires; with 2-hour listings an item may be relisted a few times before it sells.

/**
 * Expected failed (expired) listings before a sale, from a sale rate (share of listings that sell).
 * (1 - s) / s, capped at 5, matching the statistics engine.
 */
export function expectedFailedListings(saleRate) {
  if (saleRate === null || saleRate === undefined || !Number.isFinite(saleRate)) return 0;
  const s = Math.max(0.05, Math.min(1, saleRate));
  return Math.min(5, (1 - s) / s);
}

/**
 * @param {object} p
 * @param {number} p.buy        price paid per unit
 * @param {number} p.sell       price you list at per unit
 * @param {number} p.quantity   units
 * @param {number} p.cut        AH cut on the sale (0.05 faction, 0.15 neutral)
 * @param {number} p.deposit    deposit per unit per listing
 * @param {number} p.failedListings  expired listings per unit before it sells (deposit lost each time)
 * @param {number} p.minMargin  your target margin (0.1 = 10%)
 */
export function calculate({ buy, sell, quantity, cut, deposit, failedListings, minMargin }) {
  const n = Math.max(0, quantity || 0);
  const dep = Math.max(0, deposit || 0);
  const f = Math.max(0, failedListings || 0);
  const m = Math.max(0, minMargin || 0);

  const purchase = buy * n;
  const depositUpFront = dep * n; // paid on the listing that sells; refunded when it does
  const depositLost = dep * f * n; // the listings that expired
  const gross = sell * n;
  const ahCut = gross * cut;
  const net = gross - ahCut - depositLost;
  const profit = net - purchase;
  const listingCostPerUnit = dep * f;

  const profitBeforeDeposits = gross - ahCut - purchase;
  return {
    purchase,
    profitBeforeDeposits,
    marginBeforeDeposits: purchase > 0 ? profitBeforeDeposits / purchase : 0,
    /** Share of the pre-deposit profit that lost deposits take (0.1 = deposits eat 10% of it). */
    depositShareOfProfit: profitBeforeDeposits > 0 ? depositLost / profitBeforeDeposits : 0,
    /** Deposit cost per unit as a share of the buy price: how much it drags the margin. */
    depositMarginDrag: buy > 0 ? (dep * f) / buy : 0,
    depositUpFront,
    depositLost,
    gross,
    ahCut,
    net,
    profit,
    profitPerUnit: n ? profit / n : 0,
    margin: purchase > 0 ? profit / purchase : 0,
    /** Gold you need on hand: purchase plus every deposit until it sells (all but the last are lost). */
    cashNeeded: purchase + depositUpFront + depositLost,
    breakEvenSell: (buy + listingCostPerUnit) / (1 - cut),
    minSellForMargin: (buy * (1 + m) + listingCostPerUnit) / (1 - cut),
    maxBuyForMargin: (sell * (1 - cut) - listingCostPerUnit) / (1 + m),
    meetsMargin: purchase > 0 && profit / purchase >= m,
  };
}

/** "1g 2s 3c" style text for copper amounts (negative shown with a minus sign). */
export function formatMoney(copper) {
  const sign = copper < 0 ? "-" : "";
  const c = Math.round(Math.abs(copper));
  const g = Math.floor(c / 10000), s = Math.floor((c % 10000) / 100), cu = c % 100;
  const parts = [];
  if (g) parts.push(`${g.toLocaleString()}g`);
  if (s || (g && cu)) parts.push(`${s}s`);
  if (cu || parts.length === 0) parts.push(`${cu}c`);
  return sign + parts.join(" ");
}
