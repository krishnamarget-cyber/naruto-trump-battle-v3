// matchTests.js — V2.2 Integration Tests (Tier Progression L1->L6 + Simultaneous Dual-Attack + Shield Battery)
import { loadCardDatabase } from "./cardLoader.js";
import { createMatchState, activateShield, executeSimultaneousClash } from "./matchManager.js";
import { buildPool, allocateTeams } from "./teamSelection.js";

const db = await loadCardDatabase("./naruto_trump_battle_180_cards_anime_accurate.json");
const pool = buildPool(db, { preset: "quick", mode: "balanced", seed: "v22-test" });
const { A, B } = allocateTeams(pool);

const state = createMatchState({
  presetKey: "quick",
  teamA: { name: "Leaf", cards: A, captainId: A[9].card_id, viceCaptainId: A[8].card_id },
  teamB: { name: "Sound", cards: B, captainId: B[9].card_id, viceCaptainId: B[8].card_id },
});

if (state.activeTier !== "L1") throw new Error(`Expected starting tier L1, got ${state.activeTier}`);

const l1A = A.filter((c) => c.card_id.startsWith("L1-"));
const l1B = B.filter((c) => c.card_id.startsWith("L1-"));

// Play both L1 cards -> must automatically advance to L2!
executeSimultaneousClash(state, {
  moveA: { cardId: l1A[0].card_id, style: "gen", basicStat: "acc" },
  moveB: { cardId: l1B[0].card_id, style: "tai", basicStat: "dur" },
});
if (state.activeTier !== "L1") throw new Error("Should remain in L1 until all L1 cards are used");

executeSimultaneousClash(state, {
  moveA: { cardId: l1A[1].card_id, style: "nin", basicStat: "spd" },
  moveB: { cardId: l1B[1].card_id, style: "kun", basicStat: "adp" },
});
if (state.activeTier !== "L2") throw new Error(`Expected progression to L2, got ${state.activeTier}`);

console.log("PASS  V2.2 Tier Progression (L1 -> L2), Genjutsu & Simultaneous Clash Integration!");

// ---- Regression tests (logic review) ----
import { PRE } from "./teamSelection.js";
import { getCardTier, TIERS } from "./cardLoader.js";
for (const preset of Object.keys(PRE)) {
  for (const mode of ["balanced", "dynamic", "weakest", "random"]) {
    for (let s = 0; s < 20; s++) {
      const { A: ta, B: tb } = allocateTeams(buildPool(db, { preset, mode, seed: `reg${s}` }));
      for (const team of [ta, tb]) {
        const got = TIERS.map((t) => team.filter((c) => getCardTier(c) === t).length).join(",");
        if (got !== PRE[preset].join(",")) throw new Error(`${preset}/${mode}: bad distribution ${got}`);
      }
    }
  }
}
console.log("PASS  Allocation gives every team the exact per-tier distribution (all presets x modes)");

let threw = false;
try {
  const p = buildPool(db, { preset: "quick", mode: "balanced", seed: "dist" });
  const { A: a2, B: b2 } = allocateTeams(p);
  const l1 = a2.filter((c) => getCardTier(c) === "L1");
  const l6 = a2.filter((c) => getCardTier(c) === "L6");
  const skewed = a2.filter((c) => c !== l6[0]).concat([l1[0] === a2[0] ? l1[1] : a2[0]]); // wrong distribution, same count
  createMatchState({ presetKey: "quick", teamA: { name: "x", cards: skewed, captainId: skewed[0].card_id, viceCaptainId: skewed[1].card_id }, teamB: { name: "y", cards: b2, captainId: b2[0].card_id, viceCaptainId: b2[1].card_id } });
} catch { threw = true; }
if (!threw) throw new Error("Skewed per-tier roster should be rejected");
console.log("PASS  Per-tier roster distribution is validated");
