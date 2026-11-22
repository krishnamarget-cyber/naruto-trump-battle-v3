// matchManager.js — V2.2 Shared HP Pool, Strict L1->L6 Tier Progression, Simultaneous Dual-Attack & 6.0 Shield Battery
import { TIERS, getCardTier, validateCard, CardDatabaseError } from "./cardLoader.js";
import { resolveSimultaneousTurn } from "./combatEngine.js";

export const MATCH_PRESETS = Object.freeze({
  quick: Object.freeze({
    key: "quick",
    name: "Quick",
    distribution: Object.freeze([2, 2, 2, 2, 1, 1]),
    totalCards: 10,
    maxHp: 100,
    shieldHeal: 15,      // 15% of 100 HP when injured
    shieldOverheal: 10,  // 10% of 100 HP extra armor when at full HP
  }),
  standard: Object.freeze({
    key: "standard",
    name: "Standard",
    distribution: Object.freeze([3, 3, 3, 3, 2, 1]),
    totalCards: 15,
    maxHp: 150,
    shieldHeal: 23,      // ceil(15% of 150 HP) when injured
    shieldOverheal: 15,  // 10% of 150 HP extra armor when at full HP
  }),
  marathon: Object.freeze({
    key: "marathon",
    name: "Marathon",
    distribution: Object.freeze([4, 4, 4, 4, 3, 1]),
    totalCards: 20,
    maxHp: 200,
    shieldHeal: 30,      // 15% of 200 HP when injured
    shieldOverheal: 20,  // 10% of 200 HP extra armor when at full HP
  }),
});

export const SHIELD_MAX_CAPACITY = 6.0;
export const SHIELD_ACTIVATION_COST = 3.0;

function validateTeamRoster(cards, captainId, viceCaptainId, preset, label) {
  if (!Array.isArray(cards) || cards.length !== preset.totalCards) {
    throw new CardDatabaseError(
      `${label} must have exactly ${preset.totalCards} cards for ${preset.name} preset, got ${cards?.length ?? 0}.`
    );
  }
  for (let i = 0; i < TIERS.length; i++) {
    const got = cards.filter((c) => getCardTier(c) === TIERS[i]).length;
    if (got !== preset.distribution[i]) {
      throw new CardDatabaseError(
        `${label} must have ${preset.distribution[i]} ${TIERS[i]} cards for ${preset.name} preset, got ${got}.`
      );
    }
  }
  const ids = new Set();
  for (const c of cards) {
    validateCard(c, label);
    if (ids.has(c.card_id)) {
      throw new CardDatabaseError(`${label} contains duplicate card_id: ${c.card_id}`);
    }
    ids.add(c.card_id);
  }
  if (!captainId || !ids.has(captainId)) {
    throw new CardDatabaseError(`${label} captainId (${JSON.stringify(captainId)}) must belong to the team roster.`);
  }
  if (!viceCaptainId || !ids.has(viceCaptainId)) {
    throw new CardDatabaseError(`${label} viceCaptainId (${JSON.stringify(viceCaptainId)}) must belong to the team roster.`);
  }
  if (captainId === viceCaptainId) {
    throw new CardDatabaseError(`${label} Captain and Vice-Captain cannot be the same card (${captainId}).`);
  }
}


export const FIVE_ROUND_MIN_DISTINCT_STATS = 3;
export const FIVE_ROUND_MAX_SAME_STAT = 3;

/**
 * Evaluates a player's 5-round basic stat variety & cap rule:
 * Within a 5-round block (Rounds 1-5, 6-10, etc.):
 *  - Any single basic stat can be used at most 3 times (max 3x).
 *  - At least 3 distinct basic stats must be used across the 5 rounds (if 1 stat is used 3x, at least 2 other stats must be explored).
 */
export function getFiveRoundStatProgress(player) {
  const hist = Array.isArray(player.basicStatHistory) ? player.basicStatHistory : [];
  const blockStart = Math.floor(hist.length / 5) * 5;
  const blockStats = hist.slice(blockStart);
  const distinctSet = new Set(blockStats);
  const counts = { spd: 0, acc: 0, dur: 0, adp: 0 };
  for (const st of blockStats) {
    if (counts[st] !== undefined) counts[st] += 1;
  }
  const roundsUsedInBlock = blockStats.length;
  const roundsRemainingInBlock = Math.max(1, 5 - roundsUsedInBlock);
  const neededDistinct = Math.max(0, FIVE_ROUND_MIN_DISTINCT_STATS - distinctSet.size);
  const mustPickNewStatNow = neededDistinct > 0 && roundsRemainingInBlock <= neededDistinct;

  return {
    blockNumber: Math.floor(blockStart / 5) + 1,
    blockStartTurn: blockStart + 1,
    blockEndTurn: blockStart + 5,
    usedStats: blockStats,
    distinctStats: [...distinctSet],
    distinctCount: distinctSet.size,
    statCounts: counts,
    maxSameStat: FIVE_ROUND_MAX_SAME_STAT,
    minDistinctRequired: FIVE_ROUND_MIN_DISTINCT_STATS,
    roundsUsedInBlock,
    roundsRemainingInBlock,
    mustPickNewStatNow,
  };
}

export function isBasicStatAllowedInFiveRounds(player, basicStat) {
  const prog = getFiveRoundStatProgress(player);
  const usedCount = prog.statCounts[basicStat] || 0;

  if (usedCount >= FIVE_ROUND_MAX_SAME_STAT) {
    return {
      allowed: false,
      progress: prog,
      reason: `5-Round Rule: ${basicStat.toUpperCase()} already used ${usedCount}/${FIVE_ROUND_MAX_SAME_STAT} times in Rounds ${prog.blockStartTurn}–${prog.blockEndTurn}. Explore other basic stats.`,
    };
  }

  if (prog.mustPickNewStatNow && prog.distinctStats.includes(basicStat)) {
    return {
      allowed: false,
      progress: prog,
      reason: `5-Round Rule: Use at least 3 distinct basic stats in Rounds ${prog.blockStartTurn}–${prog.blockEndTurn} (you have ${prog.distinctStats.map((s) => s.toUpperCase()).join(", ") || "none"}; pick a new stat on Round ${prog.blockEndTurn}).`,
    };
  }

  return { allowed: true, progress: prog };
}

export function createPlayerState({ name, cards, captainId, viceCaptainId, preset }) {
  validateTeamRoster(cards, captainId, viceCaptainId, preset, name);
  return {
    name,
    hp: preset.maxHp,
    maxHp: preset.maxHp,
    extraArmorHp: 0,
    shields: 0.0,
    captainId,
    viceCaptainId,
    roster: cards.map((c) => ({ ...c })),
    usedCardIds: [],
    usedCombatStyles: [],
    basicStatHistory: [],
  };
}

/**
 * Determines the current active tier in strict progression: L1 -> L2 -> L3 -> L4 -> L5 -> L6.
 * A tier remains active until all cards of that tier have been used; then it automatically advances.
 */
export function getActiveProgressionTier(matchState) {
  const playerA = matchState.players.A;
  const playerB = matchState.players.B;
  for (const tier of TIERS) {
    const remA = playerA.roster.filter((c) => getCardTier(c) === tier && !playerA.usedCardIds.includes(c.card_id));
    const remB = playerB.roster.filter((c) => getCardTier(c) === tier && !playerB.usedCardIds.includes(c.card_id));
    if (remA.length > 0 || remB.length > 0) {
      return tier;
    }
  }
  return null;
}

export function createMatchState({ presetKey = "standard", explorationMode = "default", teamA, teamB }) {
  const preset = MATCH_PRESETS[presetKey];
  if (!preset) {
    throw new CardDatabaseError(`Unknown presetKey: ${JSON.stringify(presetKey)}.`);
  }

  const idsA = new Set(teamA.cards.map((c) => c.card_id));
  for (const c of teamB.cards) {
    if (idsA.has(c.card_id)) {
      throw new CardDatabaseError(`Duplicate card across teams not allowed: ${c.card_id}`);
    }
  }

  const state = {
    preset,
    explorationMode: explorationMode || "default",
    intenseMode: explorationMode === "intense",
    turn: 1,
    activeTier: "L1",
    status: "IN_PROGRESS",
    winner: null,
    players: {
      A: createPlayerState({ name: teamA.name || "Player 1", ...teamA, preset }),
      B: createPlayerState({ name: teamB.name || "Player 2", ...teamB, preset }),
    },
    history: [],
  };
  state.activeTier = getActiveProgressionTier(state) || "L1";
  return state;
}

export function activateShield(matchState, playerSide) {
  if (matchState.status !== "IN_PROGRESS") {
    throw new CardDatabaseError("Cannot activate shield: match is already finished.");
  }
  const player = matchState.players[playerSide];
  if (!player) {
    throw new CardDatabaseError(`Invalid playerSide: ${JSON.stringify(playerSide)}.`);
  }
  if (player.shields < SHIELD_ACTIVATION_COST) {
    throw new CardDatabaseError(
      `${player.name} needs at least ${SHIELD_ACTIVATION_COST.toFixed(1)} shields (currently ${player.shields.toFixed(1)}).`
    );
  }

  player.shields = Number((player.shields - SHIELD_ACTIVATION_COST).toFixed(1));
  const { maxHp, shieldHeal, shieldOverheal } = matchState.preset;

  let mode;
  let amountApplied = 0;

  if (player.hp < maxHp) {
    mode = "HEAL";
    const before = player.hp;
    player.hp = Math.min(maxHp, player.hp + shieldHeal);
    amountApplied = player.hp - before;
  } else {
    mode = "EXTRA_ARMOR";
    player.extraArmorHp += shieldOverheal;
    amountApplied = shieldOverheal;
  }

  const event = {
    type: "SHIELD_ACTIVATED",
    turn: matchState.turn,
    playerSide,
    mode,
    amountApplied,
    remainingShields: player.shields,
    hp: player.hp,
    extraArmorHp: player.extraArmorHp,
  };
  matchState.history.push(event);
  return event;
}

function applyDamageToPlayer(player, rawDamage) {
  let remaining = rawDamage;
  let absorbedByArmor = 0;
  if (remaining > 0 && player.extraArmorHp > 0) {
    absorbedByArmor = Math.min(player.extraArmorHp, remaining);
    player.extraArmorHp -= absorbedByArmor;
    remaining -= absorbedByArmor;
  }
  const hpLost = Math.min(player.hp, remaining);
  player.hp -= hpLost;
  return { absorbedByArmor, hpLost };
}

function applyLeaderOutgoingBonus(rawDamage, cardId, player) {
  if (rawDamage <= 0) return { damage: 0, bonus: "NONE" };
  if (cardId === player.captainId) {
    return { damage: rawDamage * 2, bonus: "CAPTAIN_2X" };
  }
  if (cardId === player.viceCaptainId) {
    return { damage: Math.ceil(rawDamage * 1.5), bonus: "VICE_CAPTAIN_1_5X" };
  }
  return { damage: rawDamage, bonus: "NONE" };
}

function awardDefenseShieldIfBlocked(incomingAttackDamage, cardId, player) {
  if (incomingAttackDamage > 0) {
    return { shieldEarned: 0.0, roleBonus: "NONE" };
  }
  let shieldEarned = 1.0;
  let roleBonus = "REGULAR_1X";
  if (cardId === player.captainId) {
    shieldEarned = 2.0;
    roleBonus = "CAPTAIN_2X";
  } else if (cardId === player.viceCaptainId) {
    shieldEarned = 1.5;
    roleBonus = "VICE_CAPTAIN_1_5X";
  }
  player.shields = Math.min(
    SHIELD_MAX_CAPACITY,
    Number((player.shields + shieldEarned).toFixed(1))
  );
  return { shieldEarned, roleBonus };
}

/**
 * Executes a Simultaneous Dual-Attack Turn:
 * - Enforces that both selected cards belong to `matchState.activeTier` (strict L1 -> L6 progression).
 * - Both Player A and Player B choose an Attack Style (`kun|tai|nin|gen|special`) and any 1 of the 4 Basic Stats (`spd|acc|dur|adp`).
 * - Resolves both attacks simultaneously, applies Captain (2x) / Vice-Captain (1.5x) outgoing bonuses,
 *   applies ADP counter-damage, deducts Extra Armor + HP, and awards Defender Shield (+1.0/+1.5/+2.0)
 *   to any player who takes 0 incoming attack damage.
 */
export function executeSimultaneousClash(matchState, {
  moveA, // { cardId, style, basicStat }
  moveB, // { cardId, style, basicStat }
}) {
  if (matchState.status !== "IN_PROGRESS") {
    throw new CardDatabaseError("Cannot execute clash: match is already finished.");
  }

  const requiredTier = getActiveProgressionTier(matchState);
  matchState.activeTier = requiredTier;

  const playerA = matchState.players.A;
  const playerB = matchState.players.B;

  const cardA = playerA.roster.find((c) => c.card_id === moveA.cardId);
  const cardB = playerB.roster.find((c) => c.card_id === moveB.cardId);
  if (!cardA || !cardB) {
    throw new CardDatabaseError("Selected card not found in player roster.");
  }
  if (playerA.usedCardIds.includes(cardA.card_id) || playerB.usedCardIds.includes(cardB.card_id)) {
    throw new CardDatabaseError("Selected card has already been used.");
  }
  if (getCardTier(cardA) !== requiredTier || getCardTier(cardB) !== requiredTier) {
    throw new CardDatabaseError(
      `Tier progression requires ${requiredTier} cards right now (got ${getCardTier(cardA)} vs ${getCardTier(cardB)}).`
    );
  }

  const checkA = isBasicStatAllowedInFiveRounds(playerA, moveA.basicStat);
  if (!checkA.allowed) {
    throw new CardDatabaseError(checkA.reason);
  }
  const checkB = isBasicStatAllowedInFiveRounds(playerB, moveB.basicStat);
  if (!checkB.allowed) {
    throw new CardDatabaseError(checkB.reason);
  }

  // 1. Resolve simultaneous combat math
  const simResult = resolveSimultaneousTurn({
    cardA,
    styleA: moveA.style,
    basicStatA: moveA.basicStat,
    cardB,
    styleB: moveB.style,
    basicStatB: moveB.basicStat,
  });

  // 2. Apply Captain (2.0x) and Vice-Captain (1.5x) outgoing damage bonuses
  const outA = applyLeaderOutgoingBonus(simResult.attackAtoB.damageToDefender, cardA.card_id, playerA);
  const outB = applyLeaderOutgoingBonus(simResult.attackBtoA.damageToDefender, cardB.card_id, playerB);

  // Total damage each player takes = opponent's outgoing attack damage + opponent's ADP counter-damage
  const totalDamageToB = outA.damage + simResult.attackBtoA.counterDamageToAttacker;
  const totalDamageToA = outB.damage + simResult.attackAtoB.counterDamageToAttacker;

  // 3. Deduct Extra Armor + Base HP simultaneously
  const takenB = applyDamageToPlayer(playerB, totalDamageToB);
  const takenA = applyDamageToPlayer(playerA, totalDamageToA);

  // 4. Shield earning: any player who blocked the opponent's incoming attack (0 incoming attack damage) earns Shield
  const shieldGainA = awardDefenseShieldIfBlocked(outB.damage, cardA.card_id, playerA);
  const shieldGainB = awardDefenseShieldIfBlocked(outA.damage, cardB.card_id, playerB);

  // 5. Mark cards as used & advance tier progression if current tier is cleared
  playerA.usedCardIds.push(cardA.card_id);
  playerB.usedCardIds.push(cardB.card_id);
  playerA.usedCombatStyles = [...(playerA.usedCombatStyles || []), moveA.style];
  playerB.usedCombatStyles = [...(playerB.usedCombatStyles || []), moveB.style];
  playerA.basicStatHistory.push(moveA.basicStat);
  playerB.basicStatHistory.push(moveB.basicStat);

  const nextTier = getActiveProgressionTier(matchState);
  matchState.activeTier = nextTier || "COMPLETED";

  // 6. Check victory conditions
  if (playerA.hp <= 0 && playerB.hp <= 0) {
    matchState.status = "FINISHED";
    matchState.winner = "DRAW";
  } else if (playerB.hp <= 0) {
    matchState.status = "FINISHED";
    matchState.winner = "A";
  } else if (playerA.hp <= 0) {
    matchState.status = "FINISHED";
    matchState.winner = "B";
  } else if (!nextTier) {
    matchState.status = "FINISHED";
    const totalHpA = playerA.hp + playerA.extraArmorHp;
    const totalHpB = playerB.hp + playerB.extraArmorHp;
    matchState.winner = totalHpA > totalHpB ? "A" : totalHpB > totalHpA ? "B" : "DRAW";
  }

  const record = {
    type: "SIMULTANEOUS_CLASH",
    turn: matchState.turn,
    tier: requiredTier,
    nextTier: matchState.activeTier,
    moveA: { ...moveA },
    moveB: { ...moveB },
    simResult,
    outgoingDamageAtoB: outA.damage,
    roleBonusA: outA.bonus,
    outgoingDamageBtoA: outB.damage,
    roleBonusB: outB.bonus,
    counterToA: simResult.attackAtoB.counterDamageToAttacker,
    counterToB: simResult.attackBtoA.counterDamageToAttacker,
    totalDamageToA,
    totalDamageToB,
    takenA,
    takenB,
    shieldGainA,
    shieldGainB,
    hpAfter: {
      A: { hp: playerA.hp, extraArmorHp: playerA.extraArmorHp, shields: playerA.shields },
      B: { hp: playerB.hp, extraArmorHp: playerB.extraArmorHp, shields: playerB.shields },
    },
  };

  matchState.history.push(record);
  if (matchState.status === "IN_PROGRESS") {
    matchState.turn += 1;
  }

  return record;
}


export const ALL_COMBAT_STYLES = ["tai", "nin", "gen", "kun", "special"];

export function getStyleExplorationStatus(player, styleKey, explorationMode = "default") {
  if (!explorationMode || explorationMode === "default" || !player) {
    return { allowed: true, reason: "" };
  }

  const styles = Array.isArray(player.usedCombatStyles) ? player.usedCombatStyles : [];
  const totalRounds = Array.isArray(player.roster) ? player.roster.length : 15;
  const usedCards = Array.isArray(player.usedCardIds) ? player.usedCardIds.length : 0;
  const remCards = Math.max(1, totalRounds - usedCards);

  const matchStyles = [...new Set(styles)];
  const needAllFive = Math.max(0, ALL_COMBAT_STYLES.length - matchStyles.length);
  const mustPickUnexploredMatchStyle = needAllFive > 0 && remCards <= needAllFive;

  if (explorationMode === "intense") {
    const startIdx = Math.floor(styles.length / 5) * 5;
    const blockStyles = [...new Set(styles.slice(startIdx))];
    const remInFive = Math.max(1, 5 - (styles.length - startIdx));
    const needThree = Math.max(0, 3 - blockStyles.length);
    if (needThree > 0 && remInFive <= needThree && blockStyles.includes(styleKey)) {
      return {
        allowed: false,
        reason: `Intense Mode: explore at least 3 distinct combat styles every 5 rounds (${blockStyles.length}/3 in current 5-round block).`,
      };
    }
    const needFour = Math.max(0, 4 - matchStyles.length);
    if (needFour > 0 && remCards <= needFour && matchStyles.includes(styleKey)) {
      return {
        allowed: false,
        reason: `Intense Mode: explore at least 4 distinct combat styles across the match (${matchStyles.length}/4 explored).`,
      };
    }
    return { allowed: true, reason: "" };
  }

  if (explorationMode === "intense_v2") {
    const fullBlocksCount = Math.floor(totalRounds / 6);
    const fullBlockTurnsLimit = fullBlocksCount * 6;
    const currentTurnNumber = styles.length + 1;

    if (currentTurnNumber <= fullBlockTurnsLimit) {
      const blockIdx = Math.floor(styles.length / 6);
      const startIdx = blockIdx * 6;
      const blockStyles = [...new Set(styles.slice(startIdx))];
      const remInSix = Math.max(1, 6 - (styles.length - startIdx));
      const needFourInSix = Math.max(0, 4 - blockStyles.length);
      if (needFourInSix > 0 && remInSix <= needFourInSix && blockStyles.includes(styleKey)) {
        return {
          allowed: false,
          reason: `Intense V2 Mode: explore at least 4 distinct combat styles in each full 6-round block (${blockStyles.length}/4 explored in current 6-round block).`,
        };
      }
    }

    if (mustPickUnexploredMatchStyle && matchStyles.includes(styleKey)) {
      return {
        allowed: false,
        reason: `Intense V2 Mode: must explore all 5 combat styles by the end of the match (${matchStyles.length}/5 explored).`,
      };
    }
    return { allowed: true, reason: "" };
  }

  if (explorationMode === "intense_v3") {
    const startIdx = Math.floor(styles.length / 5) * 5;
    const blockStyles = [...new Set(styles.slice(startIdx))];
    const remInFive = Math.max(1, 5 - (styles.length - startIdx));
    const needFourInFive = Math.max(0, 4 - blockStyles.length);
    if (needFourInFive > 0 && remInFive <= needFourInFive && blockStyles.includes(styleKey)) {
      return {
        allowed: false,
        reason: `Intense V3 Mode: explore at least 4 distinct combat styles within every 5 rounds (${blockStyles.length}/4 explored in current 5-round block).`,
      };
    }

    if (mustPickUnexploredMatchStyle && matchStyles.includes(styleKey)) {
      return {
        allowed: false,
        reason: `Intense V3 Mode: must explore all 5 combat styles by the end of the match (${matchStyles.length}/5 explored).`,
      };
    }
    return { allowed: true, reason: "" };
  }

  return { allowed: true, reason: "" };
}
