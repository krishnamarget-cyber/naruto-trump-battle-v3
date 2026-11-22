// computerAi.js — Smart Computer Opponent for Vs Computer Mode (Medium: ~80% best choice, Hard: 100% best choice without peeking at opponent card)
import { getCardTier } from "./cardLoader.js";
import { getActiveProgressionTier, isBasicStatAllowedInFiveRounds } from "./matchManager.js";

const STYLES = ["tai", "nin", "gen", "kun", "special"];
const BASIC_STATS = ["spd", "acc", "dur", "adp"];

function scoreCardForStyle(card, style, tierAverages = null) {
  const tier = getCardTier(card);
  const atk = Number(card[`${style}_atk`] || 0);
  const def = Number(card[`${style}_def`] || 0);
  const avgAtk = tierAverages?.[tier]?.[`${style}_atk`] ?? atk;
  const avgDef = tierAverages?.[tier]?.[`${style}_def`] ?? def;

  // Style-specific nuance: Genjutsu requires strong gen_atk relative to def to avoid 90% power gate
  let styleScore = atk * 1.15 + def * 0.75 + (atk - avgAtk) * 0.5 + (def - avgDef) * 0.25;
  if (style === "gen") {
    styleScore += atk * 0.15;
  }
  return styleScore;
}

function scoreBasicStatForCard(card, style, stat, tierAverages = null) {
  const tier = getCardTier(card);
  const atk = Number(card[`${style}_atk`] || 0);
  const def = Number(card[`${style}_def`] || 0);
  const val = Number(card[stat] || 0);
  const avgVal = tierAverages?.[tier]?.[stat] ?? val;

  // Without knowing opponent's exact card, infer likely branch from card's style ATK vs DEF and tier baseline
  const likelyBreakthrough = atk >= def;
  let score = val * 1.1 + (val - avgVal) * 0.6;

  if (stat === "acc") {
    score += likelyBreakthrough ? 14 : -10;
  } else if (stat === "dur") {
    score += likelyBreakthrough ? 12 : -10;
  } else if (stat === "spd") {
    score += !likelyBreakthrough ? 14 : -8;
    if (style === "gen" && atk < def * 0.92) score -= 12;
  } else if (stat === "adp") {
    score += !likelyBreakthrough ? 13 : -10;
  }

  return score;
}

/**
 * Picks leaders (Captain & Vice-Captain) for the computer player.
 */
export function chooseComputerLeaders(cards, difficulty = "hard", tierAverages = null) {
  if (!Array.isArray(cards) || cards.length < 2) {
    return { captainId: cards?.[0]?.card_id, viceCaptainId: cards?.[1]?.card_id };
  }

  const ranked = [...cards]
    .map((c) => {
      const tier = getCardTier(c);
      const bestStyle = STYLES.reduce((best, st) => {
        const sc = scoreCardForStyle(c, st, tierAverages);
        return sc > best.sc ? { st, sc } : best;
      }, { st: "tai", sc: -Infinity });
      const basicAvg = (Number(c.spd || 0) + Number(c.acc || 0) + Number(c.dur || 0) + Number(c.adp || 0)) / 4;
      const tierWeight = { L1: 1, L2: 1.1, L3: 1.2, L4: 1.4, L5: 1.6, L6: 1.9 }[tier] || 1;
      return { card: c, score: (bestStyle.sc + basicAvg * 0.5) * tierWeight };
    })
    .sort((a, b) => b.score - a.score);

  const capIdx = difficulty === "hard" ? 0 : Math.random() < 0.8 ? 0 : Math.min(1, ranked.length - 1);
  const capCard = ranked[capIdx].card;

  const remaining = ranked.filter((x) => x.card.card_id !== capCard.card_id);
  const vcIdx = difficulty === "hard" ? 0 : Math.random() < 0.8 ? 0 : Math.min(1, remaining.length - 1);
  const vcCard = remaining[vcIdx].card;

  return {
    captainId: capCard.card_id,
    viceCaptainId: vcCard.card_id,
  };
}

/**
 * Chooses the computer's move { cardId, style, basicStat } for the current turn
 * WITHOUT reading the human opponent's chosen card/move (blind to opponent card).
 * - difficulty === "hard": 100% best tactical pick
 * - difficulty === "medium": ~80% chance to pick the best option, ~20% alternative/suboptimal pick
 */
export function chooseComputerMove(matchState, side = "B", difficulty = "hard", tierAverages = null) {
  const activeTier = getActiveProgressionTier(matchState);
  const player = matchState.players[side];
  const availableCards = player.roster.filter(
    (c) => getCardTier(c) === activeTier && !player.usedCardIds.includes(c.card_id)
  );

  if (!availableCards.length) {
    throw new Error(`No available cards for computer (${side}) in tier ${activeTier}`);
  }

  const allowedStats = BASIC_STATS.filter((st) => isBasicStatAllowedInFiveRounds(player, st).allowed);
  const candidateStats = allowedStats.length ? allowedStats : BASIC_STATS;

  // Evaluate all (card, style, stat) combinations purely from own card + tier context + 5-round rule
  const combinations = [];
  for (const card of availableCards) {
    const isCap = card.card_id === player.captainId;
    const isVc = card.card_id === player.viceCaptainId;
    const leaderMult = isCap ? 1.22 : isVc ? 1.12 : 1.0;

    for (const style of STYLES) {
      const styleSc = scoreCardForStyle(card, style, tierAverages) * leaderMult;
      for (const basicStat of candidateStats) {
        const statSc = scoreBasicStatForCard(card, style, basicStat, tierAverages);
        combinations.push({
          move: { cardId: card.card_id, style, basicStat },
          totalScore: styleSc + statSc,
        });
      }
    }
  }

  combinations.sort((a, b) => b.totalScore - a.totalScore);
  const bestCombo = combinations[0];

  const useBest = difficulty === "hard" ? true : Math.random() < 0.8;
  if (useBest || combinations.length === 1) {
    return bestCombo.move;
  }

  // In Medium mode (~20% of the time), pick from non-top combinations (favoring lower-ranked options)
  const lowerPool = combinations.slice(Math.max(1, Math.floor(combinations.length * 0.25)));
  const fallbackPool = lowerPool.length ? lowerPool : combinations.slice(1);
  const idx = Math.floor(Math.random() * fallbackPool.length);
  return fallbackPool[idx].move;
}
