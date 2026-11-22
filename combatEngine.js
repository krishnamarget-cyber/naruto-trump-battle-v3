// combatEngine.js — V2.6 Combat Calculation Engine (2x2 Specialist Matrix + 2-Layer Graduated Basic Stats)
import { STYLES, validateCard, validateSameTierMatchup, CardDatabaseError } from "./cardLoader.js";

const BASIC_STATS = ["spd", "acc", "dur", "adp"];
const ATK_CHOICES = ["spd", "acc", "none"];
const DEF_CHOICES = ["dur", "adp", "none"];
const HIGH_TIERS = new Set(["L4", "L5", "L6"]);

// ---------------------------------------------------------------------------
// V2.6 LOCKED TIER CONSTANTS (L1 - L6)
// ---------------------------------------------------------------------------

// 1. SPEED (Guard Hold: DEF >= ATK; Genjutsu requires gen_atk >= 0.90 * gen_def)
const SPD_ENTRY_OFFSET = { L1: 0, L2: 2, L3: 0, L4: 0, L5: 0, L6: 2 };
const SPD_ELITE_ORDER = ["BLITZ", "BLINDSPOT", "FLANK"];
const SPD_ELITE_THRESHOLDS = {
  L1: { BLITZ: [13, 1.02], BLINDSPOT: [9, 0.93], FLANK: [5, 0.89] },
  L2: { BLITZ: [15, 1.02], BLINDSPOT: [11, 0.93], FLANK: [5, 0.89] },
  L3: { BLITZ: [17, 1.02], BLINDSPOT: [11, 0.94], FLANK: [7, 0.89] },
  L4: { BLITZ: [13, 1.06], BLINDSPOT: [9, 1.02], FLANK: [5, 0.98] },
  L5: { BLITZ: [13, 1.02], BLINDSPOT: [9, 0.96], FLANK: [7, 0.89] },
  L6: { BLITZ: [15, 1.02], BLINDSPOT: [9, 0.98], FLANK: [5, 0.89] },
};
const SPD_ELITE_PARAMS = {
  FLANK: { cut: 0.16, mult: 1.05, chip: 4 },
  BLINDSPOT: { cut: 0.26, mult: 1.15, chip: 7 },
  BLITZ: { cut: 0.38, mult: 1.25, chip: 11 },
};

// 2. ACCURACY (Breakthrough: ATK > DEF — Gentle Elite lead k+2 so top ACC cards convert more reliably without over-powering)
const ACC_ENTRY_LEAD = { L1: 4, L2: 4, L3: 2, L4: 2, L5: 2, L6: 6 };
const ACC_ELITE_EXTRA_LEAD = 2;
const ACC_ELITE_FLOOR = { L1: 1.12, L2: 1.01, L3: 1.08, L4: 1.01, L5: 1.01, L6: 0.96 };

// 3. DURABILITY (Breakthrough: ATK > DEF)
const DUR_ENTRY_OFFSET = { L1: 2, L2: 2, L3: 0, L4: 0, L5: 0, L6: 4 };
const DUR_ELITE_RULES = {
  L1: { lead: 1, floor: 0.73 },
  L2: { lead: 1, floor: 0.79 },
  L3: { lead: 3, floor: 0.76 },
  L4: { lead: 5, floor: 0.85 },
  L5: { lead: 1, floor: 0.96 },
  L6: { lead: 0, floor: 0.91 },
};

// 4. ADAPTABILITY (Guard Hold: DEF >= ATK; Option C: B uses original DEF)
const ADP_ENTRY_LEAD = { L1: 2, L2: 3, L3: 2, L4: 2, L5: 2, L6: 3 };
const ADP_ELITE_RULES = {
  L1: { lead: 3, floor: 1.28 },
  L2: { lead: 3, floor: 1.25 },
  L3: { lead: 3, floor: 1.16 },
  L4: { lead: 3, floor: 1.06 },
  L5: { lead: 3, floor: 1.07 },
  L6: { lead: 1, floor: 1.04 },
};


export const TIER_RULES_CONFIG = Object.freeze({
  HIGH_TIERS: Object.freeze(["L4", "L5", "L6"]),
  SPD_ENTRY_OFFSET: Object.freeze({ ...SPD_ENTRY_OFFSET }),
  SPD_ELITE_THRESHOLDS: Object.freeze({ ...SPD_ELITE_THRESHOLDS }),
  SPD_ELITE_PARAMS: Object.freeze({ ...SPD_ELITE_PARAMS }),
  ACC_ENTRY_LEAD: Object.freeze({ ...ACC_ENTRY_LEAD }),
  ACC_ELITE_EXTRA_LEAD,
  ACC_ELITE_FLOOR: Object.freeze({ ...ACC_ELITE_FLOOR }),
  ACC_CHIP_BONUS: 1,
  ACC_ENTRY_BONUS: Object.freeze({ low: 2, high: 3 }),
  ACC_ELITE_BONUS: Object.freeze({ low: 5, high: 6 }),
  SPD_GLANCE_BONUS: Object.freeze({ low: 1, high: 2 }),
  DUR_ENTRY_OFFSET: Object.freeze({ ...DUR_ENTRY_OFFSET }),
  DUR_ELITE_RULES: Object.freeze({ ...DUR_ELITE_RULES }),
  DUR_MAX_CAP_PCT: 30,
  ADP_ENTRY_LEAD: Object.freeze({ ...ADP_ENTRY_LEAD }),
  ADP_ELITE_RULES: Object.freeze({ ...ADP_ELITE_RULES }),
  ADP_ENTRY_COUNTER: Object.freeze({ low: 1, high: 2 }),
});

function durEliteReductionPercent(damage) {
  if (damage <= 4) return 20;
  return 30; // V2.7: hard cap at 30% (matches rules modal and UI labels)
}

function validateInput({ attacker, defender, style, atkChoice = "none", defChoice = "none" }) {
  validateCard(attacker, "attacker");
  validateCard(defender, "defender");
  if (!STYLES.includes(style)) {
    throw new CardDatabaseError(`Invalid style: ${JSON.stringify(style)}. Allowed: ${STYLES.join(", ")}.`);
  }
  if (!ATK_CHOICES.includes(atkChoice)) {
    throw new CardDatabaseError(`Invalid atkChoice: ${JSON.stringify(atkChoice)}. Allowed: ${ATK_CHOICES.join(", ")}.`);
  }
  if (!DEF_CHOICES.includes(defChoice)) {
    throw new CardDatabaseError(`Invalid defChoice: ${JSON.stringify(defChoice)}. Allowed: ${DEF_CHOICES.join(", ")}.`);
  }
  return validateSameTierMatchup(attacker, defender);
}

/**
 * Resolves a single directional attack (`attacker` using `style` against `defender`).
 * Follows the V2.6 2x2 Specialist Matrix:
 *   - Breakthrough (ATK > DEF): ACC (offense) & DUR (defense)
 *   - Guard Hold   (DEF >= ATK): SPD (offense) & ADP (defense)
 */
export function resolveClash(input) {
  const tier = validateInput(input);
  const { attacker, defender, style, atkChoice = "none", defChoice = "none" } = input;
  const isHighTier = HIGH_TIERS.has(tier);

  const ATK = attacker[`${style}_atk`];
  const DEF = defender[`${style}_def`];
  const breakdown = [];
  breakdown.push(
    `[${attacker.character_version} -> ${defender.character_version}] Tier ${tier}, Style ${style.toUpperCase()}: ATK ${ATK} vs DEF ${DEF}.`
  );

  let branch;
  let damage = 0;
  let counter = 0;
  let atkMod = "NONE";
  let defMod = "NONE";

  let atkStatStatus = {
    stat: atkChoice,
    activated: false,
    layer: "NONE",
    label: "None",
    bonusText: "No Offense Stat Picked",
    reason: "",
  };
  let defStatStatus = {
    stat: defChoice,
    activated: false,
    layer: "NONE",
    label: "None",
    bonusText: "No Defense Stat Picked",
    reason: "",
  };

  if (ATK > DEF) {
    // ---------------- Branch 1: DIRECT_BREAKTHROUGH (ACC & DUR) ----------------
    branch = "DIRECT_BREAKTHROUGH";
    const baseDamage = 4 + Math.ceil((ATK - DEF) / 1.5);
    damage = baseDamage;
    breakdown.push(`DIRECT_BREAKTHROUGH: Base damage = 4 + ceil((${ATK} - ${DEF}) / 1.5) = ${baseDamage}.`);

    // Offense: ACC (2-Layer) | SPD inactive in Breakthrough
    if (atkChoice === "acc") {
      const k = ACC_ENTRY_LEAD[tier];
      const eliteLead = k + ACC_ELITE_EXTRA_LEAD;
      const eliteFloorNeed = ACC_ELITE_FLOOR[tier] * DEF;

      const atkMargin = ATK - DEF;
      if (attacker.acc >= defender.acc + eliteLead && attacker.acc >= eliteFloorNeed && atkMargin >= 2) {
        const bonus = isHighTier ? 6 : 5;
        damage += bonus;
        atkMod = "ACC_CRITICAL";
        atkStatStatus = {
          stat: "acc",
          activated: true,
          layer: "ELITE",
          label: "Perfect Weak-Point Hit",
          bonusText: `+${bonus} HP Bonus DMG`,
          reason: `ACC ${attacker.acc} >= ${defender.acc + eliteLead}, >= ${eliteFloorNeed.toFixed(1)} & ATK+${atkMargin}`,
        };
        breakdown.push(
          `ACC Elite (Critical Weak-Point: ${attacker.acc} >= ${defender.acc + eliteLead} & >= ${eliteFloorNeed.toFixed(1)}): +${bonus} HP -> ${damage}.`
        );
      } else if (attacker.acc >= defender.acc + k) {
        const bonus = isHighTier ? 3 : 2;
        damage += bonus;
        atkMod = "ACC_PRECISION";
        atkStatStatus = {
          stat: "acc",
          activated: true,
          layer: "ENTRY",
          label: "Precision Hit",
          bonusText: `+${bonus} HP Bonus DMG`,
          reason: `ACC ${attacker.acc} >= ${defender.acc + k}`,
        };
        breakdown.push(
          `ACC Entry (Precision Hit: ${attacker.acc} >= ${defender.acc + k}): +${bonus} HP -> ${damage}.`
        );
      } else if (attacker.acc >= defender.acc) {
        const chip = 1;
        damage += chip;
        atkMod = "ACC_CHIP";
        atkStatStatus = {
          stat: "acc",
          activated: true,
          layer: "CHIP",
          label: "Chip Precision",
          bonusText: `+${chip} HP Chip DMG`,
          reason: `ACC ${defender.acc + k} >= ${attacker.acc} >= ${defender.acc}`,
        };
        breakdown.push(
          `ACC Chip (${defender.acc + k} >= ${attacker.acc} >= ${defender.acc}): +${chip} HP chip -> ${damage}.`
        );
      } else {
        atkStatStatus = {
          stat: "acc",
          activated: false,
          layer: "NONE",
          label: "Not Triggered",
          bonusText: "+0 HP",
          reason: `ACC ${attacker.acc} < ${defender.acc}`,
        };
        breakdown.push(`ACC did not trigger (${attacker.acc} < ${defender.acc}).`);
      }
    } else if (atkChoice === "spd") {
      atkStatStatus = {
        stat: "spd",
        activated: false,
        layer: "NONE",
        label: "Wrong Branch",
        bonusText: "+0 HP",
        reason: "SPD only triggers on Guard Hold (DEF >= ATK)",
      };
    }

    // Defense: DUR (2-Layer) | ADP inactive in Breakthrough
    if (defChoice === "dur") {
      const eliteRule = DUR_ELITE_RULES[tier];
      const durLead = defender.dur - attacker.dur;
      const eliteFloorNeed = eliteRule.floor * ATK;
      const entryOffset = DUR_ENTRY_OFFSET[tier];

      if (durLead >= eliteRule.lead && defender.dur >= eliteFloorNeed) {
        const pct = durEliteReductionPercent(damage);
        const before = damage;
        damage = Math.max(1, Math.floor((damage * (100 - pct)) / 100));
        const saved = before - damage;
        defMod = "DUR_HEAVY_TANK";
        defStatStatus = {
          stat: "dur",
          activated: true,
          layer: "ELITE",
          label: `Heavy Tank (-${pct}%)`,
          bonusText: `-${saved} HP Saved`,
          reason: `DUR lead +${durLead} & ${defender.dur} >= ${eliteFloorNeed.toFixed(1)}`,
        };
        breakdown.push(`DUR Elite (Heavy Tank -${pct}%): damage ${before} -> ${damage}.`);
      } else if (defender.dur >= attacker.dur - entryOffset) {
        const before = damage;
        const savedCap = Math.min(2, Math.max(1, Math.ceil(damage * 0.15)));
        damage = Math.max(1, damage - savedCap);
        const actualSaved = before - damage;
        defMod = "DUR_LIGHT_BRACE";
        defStatStatus = {
          stat: "dur",
          activated: true,
          layer: "ENTRY",
          label: "Light Brace (-15%)",
          bonusText: `-${actualSaved} HP Saved`,
          reason: `DUR ${defender.dur} >= ${attacker.dur - entryOffset}`,
        };
        breakdown.push(
          `DUR Entry (Light Brace -${actualSaved} HP): damage ${before} -> ${damage}.`
        );
      } else {
        defStatStatus = {
          stat: "dur",
          activated: false,
          layer: "NONE",
          label: "Not Triggered",
          bonusText: "0 HP Saved",
          reason: `DUR ${defender.dur} < req ${attacker.dur - entryOffset}`,
        };
        breakdown.push(`DUR did not trigger (${defender.dur} < ${attacker.dur - entryOffset}).`);
      }
    } else if (defChoice === "adp") {
      defStatStatus = {
        stat: "adp",
        activated: false,
        layer: "NONE",
        label: "Wrong Branch",
        bonusText: "0 Counter",
        reason: "ADP only triggers on Guard Hold (DEF >= ATK)",
      };
    }
  } else {
    // ---------------- Branch 2: GUARD_HOLDS (SPD & ADP) ----------------
    branch = "GUARD_HOLDS";
    breakdown.push(`GUARD_HOLDS: DEF ${DEF} >= ATK ${ATK}.`);

    // Offense: SPD (2-Layer + Genjutsu 90% Power Gate) | ACC inactive in Guard Hold
    if (atkChoice === "spd") {
      const genBlocked = style === "gen" && ATK < 0.9 * DEF;
      if (genBlocked) {
        atkStatStatus = {
          stat: "spd",
          activated: false,
          layer: "NONE",
          label: "Genjutsu Gate",
          bonusText: "0 DMG",
          reason: `GEN ATK ${ATK} < 90% of DEF ${DEF}`,
        };
        breakdown.push(`SPD blocked by Genjutsu Power Gate (GEN ATK ${ATK} < 90% of DEF ${DEF}): damage = 0.`);
      } else {
        const spdLead = attacker.spd - defender.spd;
        let chosenElite = null;
        for (const name of SPD_ELITE_ORDER) {
          const [minLead, floor] = SPD_ELITE_THRESHOLDS[tier][name];
          if (spdLead >= minLead && attacker.spd >= floor * DEF) {
            chosenElite = name;
            break;
          }
        }

        if (chosenElite) {
          const p = SPD_ELITE_PARAMS[chosenElite];
          const defEff = Number((DEF * (1 - p.cut)).toFixed(2));
          if (ATK > defEff) {
            const raw = Math.ceil(((ATK - defEff) * p.mult) / 2);
            damage = Math.max(p.chip, raw);
          } else {
            damage = p.chip;
          }
          atkMod = `SPD_${chosenElite}`;
          atkStatStatus = {
            stat: "spd",
            activated: true,
            layer: "ELITE",
            label: `${chosenElite} Opening`,
            bonusText: `+${damage} HP Guard Break`,
            reason: `SPD lead +${spdLead}, DEF cut ${Math.round(p.cut * 100)}%`,
          };
          breakdown.push(`SPD Elite (${chosenElite}, DEF_eff ${defEff}): damage = ${damage}.`);
        } else if (attacker.spd >= defender.spd - SPD_ENTRY_OFFSET[tier]) {
          damage = isHighTier ? 2 : 1;
          atkMod = "SPD_GLANCE";
          atkStatStatus = {
            stat: "spd",
            activated: true,
            layer: "ENTRY",
            label: "Glance Opening",
            bonusText: `+${damage} HP Chip DMG`,
            reason: `SPD ${attacker.spd} >= ${defender.spd - SPD_ENTRY_OFFSET[tier]}`,
          };
          breakdown.push(
            `SPD Entry (Glance: ${attacker.spd} >= ${defender.spd - SPD_ENTRY_OFFSET[tier]}): damage = ${damage}.`
          );
        } else {
          atkStatStatus = {
            stat: "spd",
            activated: false,
            layer: "NONE",
            label: "Not Triggered",
            bonusText: "0 DMG",
            reason: `SPD ${attacker.spd} < req ${defender.spd - SPD_ENTRY_OFFSET[tier]}`,
          };
          breakdown.push(`SPD opening failed (${attacker.spd} < ${defender.spd - SPD_ENTRY_OFFSET[tier]}): damage = 0.`);
        }
      }
    } else if (atkChoice === "acc") {
      atkStatStatus = {
        stat: "acc",
        activated: false,
        layer: "NONE",
        label: "Wrong Branch",
        bonusText: "0 DMG",
        reason: "ACC only triggers on Breakthrough (ATK > DEF)",
      };
      breakdown.push(`Attacker selected ACC on Guard Hold: guard holds at 0 damage.`);
    } else {
      breakdown.push(`Attacker did not select SPD: guard holds at 0 damage.`);
    }

    // Defense: ADP (2-Layer, Option C: B uses original DEF) | DUR inactive in Guard Hold
    if (defChoice === "adp") {
      const eliteRule = ADP_ELITE_RULES[tier];
      const B = Math.ceil((ATK + DEF) / 2);
      const adpReq = Math.max(attacker.adp + eliteRule.lead, Math.ceil(B * eliteRule.floor));
      const entryLead = ADP_ENTRY_LEAD[tier];

      if (DEF > ATK && defender.adp >= adpReq) {
        const margin = defender.adp - adpReq;
        const before = damage;
        let level;
        let cutPct;
        if (margin <= 3) {
          level = "FLANK";
          cutPct = 40;
          if (damage > 0) damage = Math.max(1, Math.floor(damage * 0.6));
          counter = 3;
        } else if (margin <= 7) {
          level = "BLINDSPOT";
          cutPct = 65;
          if (damage > 0) damage = Math.max(1, Math.floor(damage * 0.35));
          counter = 4;
        } else {
          level = "BLITZ";
          cutPct = 100;
          damage = 0;
          counter = 5;
        }
        const saved = before - damage;
        defMod = `ADP_${level}`;
        defStatStatus = {
          stat: "adp",
          activated: true,
          layer: "ELITE",
          label: `${level} Counter-Read`,
          bonusText: saved > 0 ? `+${counter} HP Counter · -${saved} HP Cut` : `+${counter} HP Counter`,
          reason: `ADP ${defender.adp} >= ${adpReq} (+${margin}) · -${cutPct}% cut`,
        };
        breakdown.push(
          `ADP Elite (${level}, margin +${margin} over ${adpReq}): damage ${before} -> ${damage}, counter = ${counter}.`
        );
      } else if (DEF > ATK && damage > 0 && defender.adp >= attacker.adp + entryLead) {
        const before = damage;
        damage = Math.max(1, Math.floor(damage * 0.8));
        const saved = before - damage;
        counter = isHighTier ? 2 : 1;
        defMod = "ADP_TACTICAL_READ";
        defStatStatus = {
          stat: "adp",
          activated: true,
          layer: "ENTRY",
          label: "Tactical Read",
          bonusText: saved > 0 ? `+${counter} HP Counter · -${saved} HP Cut` : `+${counter} HP Counter`,
          reason: `DEF > ATK, incoming ${before} DMG & ADP ${defender.adp} >= ${attacker.adp + entryLead}`,
        };
        breakdown.push(
          `ADP Entry (Tactical Read: DEF > ATK, incoming ${before} DMG & ADP ${defender.adp} >= ${attacker.adp + entryLead}): damage ${before} -> ${damage}, counter = ${counter}.`
        );
      } else {
        const failReason =
          DEF <= ATK
            ? `Tied DEF (${DEF} = ATK ${ATK}) — requires DEF > ATK`
            : damage <= 0
            ? "No incoming SPD opening damage to counter"
            : `ADP ${defender.adp} < req ${attacker.adp + entryLead}`;
        defStatStatus = {
          stat: "adp",
          activated: false,
          layer: "NONE",
          label: "Not Triggered",
          bonusText: "0 Counter",
          reason: failReason,
        };
        breakdown.push(`ADP did not trigger (${failReason}).`);
      }
    } else if (defChoice === "dur") {
      defStatStatus = {
        stat: "dur",
        activated: false,
        layer: "NONE",
        label: "Wrong Branch",
        bonusText: "0 Saved",
        reason: "DUR only triggers on Breakthrough (ATK > DEF)",
      };
    }
  }

  damage = Math.max(0, damage);
  counter = Math.max(0, counter);
  breakdown.push(`Directional Result: damageToDefender = ${damage}, counterDamageToAttacker = ${counter}.`);

  return {
    tier,
    style,
    atkChoice,
    defChoice,
    atk: ATK,
    def: DEF,
    branch,
    atkModifierTriggered: atkMod,
    defModifierTriggered: defMod,
    atkStatStatus,
    defStatStatus,
    damageToDefender: damage,
    counterDamageToAttacker: counter,
    breakdown,
  };
}

/**
 * Resolves a Simultaneous Dual-Attack Turn between Player A and Player B:
 * - Each player selects a same-tier card, an Attack Style (`kun|tai|nin|gen|special`),
 *   and ANY 1 of the 4 Basic Stats (`spd|acc|dur|adp`).
 */
export function resolveSimultaneousTurn({ cardA, styleA, basicStatA, cardB, styleB, basicStatB }) {
  if (!BASIC_STATS.includes(basicStatA) || !BASIC_STATS.includes(basicStatB)) {
    throw new CardDatabaseError(`Basic stat must be one of ${BASIC_STATS.join(", ")}.`);
  }
  const tier = validateSameTierMatchup(cardA, cardB);

  const atkChoiceA = basicStatA === "spd" || basicStatA === "acc" ? basicStatA : "none";
  const defChoiceA = basicStatA === "dur" || basicStatA === "adp" ? basicStatA : "none";

  const atkChoiceB = basicStatB === "spd" || basicStatB === "acc" ? basicStatB : "none";
  const defChoiceB = basicStatB === "dur" || basicStatB === "adp" ? basicStatB : "none";

  const attackAtoB = resolveClash({
    attacker: cardA,
    defender: cardB,
    style: styleA,
    atkChoice: atkChoiceA,
    defChoice: defChoiceB,
  });

  const attackBtoA = resolveClash({
    attacker: cardB,
    defender: cardA,
    style: styleB,
    atkChoice: atkChoiceB,
    defChoice: defChoiceA,
  });

  return {
    tier,
    attackAtoB,
    attackBtoA,
  };
}
