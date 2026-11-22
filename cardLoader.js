// cardLoader.js — loads and validates the Naruto Trump Battle 180-card database (5 styles including Genjutsu).
export const TIERS = Object.freeze(["L1", "L2", "L3", "L4", "L5", "L6"]);
export const STYLES = Object.freeze(["kun", "tai", "nin", "gen", "special"]);

export const NUMERIC_FIELDS = Object.freeze([
  "spd", "acc", "dur", "adp",
  "kun_atk", "kun_def",
  "tai_atk", "tai_def",
  "nin_atk", "nin_def",
  "gen_atk", "gen_def",
  "special_atk", "special_def",
]);

export const STRING_FIELDS = Object.freeze(["card_id", "character_version"]);

export class CardDatabaseError extends Error {
  constructor(message) {
    super(message);
    this.name = "CardDatabaseError";
  }
}

export function normalizeTier(tier) {
  let t = tier;
  if (typeof t === "number" && Number.isInteger(t)) t = `L${t}`;
  if (typeof t === "string") t = t.trim().toUpperCase();
  if (!TIERS.includes(t)) {
    throw new CardDatabaseError(`Invalid tier: ${JSON.stringify(tier)}. Expected one of ${TIERS.join(", ")}.`);
  }
  return t;
}

export function getCardTier(card) {
  if (card === null || typeof card !== "object") {
    throw new CardDatabaseError("Cannot determine tier: card is not an object.");
  }
  let fromField = null;
  if (card.tier !== undefined && card.tier !== null) {
    fromField = normalizeTier(card.tier);
  }
  let fromId = null;
  if (typeof card.card_id === "string") {
    const m = /^(L[1-6])(?![0-9])/i.exec(card.card_id.trim());
    if (m) fromId = m[1].toUpperCase();
  }
  if (fromField && fromId && fromField !== fromId) {
    throw new CardDatabaseError(`Card ${card.card_id} has conflicting tiers: field=${fromField}, card_id=${fromId}.`);
  }
  const tier = fromField ?? fromId;
  if (!tier) {
    throw new CardDatabaseError(`Cannot determine tier for card ${JSON.stringify(card.card_id)}.`);
  }
  return tier;
}

export function validateCard(card, label = "card") {
  if (card === null || typeof card !== "object" || Array.isArray(card)) {
    throw new CardDatabaseError(`Invalid ${label}: expected an object.`);
  }
  for (const f of STRING_FIELDS) {
    if (typeof card[f] !== "string" || card[f].trim() === "") {
      throw new CardDatabaseError(`Invalid ${label}: missing or empty "${f}".`);
    }
  }
  for (const f of NUMERIC_FIELDS) {
    const v = card[f];
    if (v === undefined || v === null) {
      throw new CardDatabaseError(`Invalid ${label} (${card.card_id}): missing field "${f}".`);
    }
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw new CardDatabaseError(`Invalid ${label} (${card.card_id}): "${f}" must be a non-negative finite number.`);
    }
  }
  getCardTier(card);
  return card;
}

export function validateSameTierMatchup(a, b) {
  const ta = getCardTier(a);
  const tb = getCardTier(b);
  if (ta !== tb) {
    throw new CardDatabaseError(`Cross-tier matchup not allowed: ${a.card_id} is ${ta}, ${b.card_id} is ${tb}.`);
  }
  return ta;
}

export function createCardDatabase(raw, options = {}) {
  const { strictCounts = true, expectedPerTier = 30 } = options;
  const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.cards) ? raw.cards : null;
  if (!list) {
    throw new CardDatabaseError('Database must be an array of cards or an object with a "cards" array.');
  }

  const byId = new Map();
  const byTier = new Map(TIERS.map((t) => [t, []]));

  list.forEach((card, i) => {
    validateCard(card, `card at index ${i}`);
    if (byId.has(card.card_id)) {
      throw new CardDatabaseError(`Duplicate card_id: ${card.card_id}`);
    }
    const frozen = Object.freeze({ ...card });
    byId.set(card.card_id, frozen);
    byTier.get(getCardTier(frozen)).push(frozen);
  });

  if (strictCounts) {
    if (list.length !== expectedPerTier * TIERS.length) {
      throw new CardDatabaseError(`Expected ${expectedPerTier * TIERS.length} cards, found ${list.length}.`);
    }
    for (const t of TIERS) {
      if (byTier.get(t).length !== expectedPerTier) {
        throw new CardDatabaseError(`Expected ${expectedPerTier} cards in ${t}, found ${byTier.get(t).length}.`);
      }
    }
  }

  return Object.freeze({
    size: byId.size,
    getCardById(cardId) {
      const c = byId.get(cardId);
      if (!c) throw new CardDatabaseError(`Card not found: ${JSON.stringify(cardId)}`);
      return c;
    },
    getCardsByTier(tier) {
      return byTier.get(normalizeTier(tier)).slice();
    },
    validateSameTierMatchup,
  });
}

let activeDatabase = null;

export async function loadCardDatabase(
  path = "./naruto_trump_battle_180_cards_anime_accurate.json",
  options = {}
) {
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(path, "utf8");
  const parsed = JSON.parse(text);
  activeDatabase = createCardDatabase(parsed, options);
  return activeDatabase;
}

export function setActiveDatabase(db) {
  activeDatabase = db;
}

export function getCardById(cardId) {
  if (!activeDatabase) throw new CardDatabaseError("No database loaded.");
  return activeDatabase.getCardById(cardId);
}

export function getCardsByTier(tier) {
  if (!activeDatabase) throw new CardDatabaseError("No database loaded.");
  return activeDatabase.getCardsByTier(tier);
}
