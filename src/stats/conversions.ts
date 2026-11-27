// Item conversions you can trade on: buy one item, turn it into another, sell that. For now the
// enchanting essences: 3 Lesser make 1 Greater, and 1 Greater splits into 3 Lesser (right-click;
// anyone can do it, no Enchanting needed).

export interface Conversion { name: string; from: string; to: string; fromQty: number; toQty: number; verb: string }

export const ESSENCE_PAIRS = ["Magic", "Astral", "Mystic", "Nether", "Eternal"].map((n) => ({ name: n, lesser: `Lesser ${n} Essence`, greater: `Greater ${n} Essence` }));

/** Every conversion, both ways: combine (3 Lesser -> 1 Greater) and split (1 Greater -> 3 Lesser). */
export const CONVERSIONS: Conversion[] = ESSENCE_PAIRS.flatMap((p) => [
  { name: `${p.name} essence`, from: p.lesser, to: p.greater, fromQty: 3, toQty: 1, verb: "combine" },
  { name: `${p.name} essence`, from: p.greater, to: p.lesser, fromQty: 1, toQty: 3, verb: "split" },
]);
