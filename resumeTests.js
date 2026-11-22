// resumeTests.js — a match saved as JSON and restored must continue exactly like the original.
import { loadCardDatabase, getCardTier } from "./cardLoader.js";
import { MATCH_PRESETS, createMatchState, executeSimultaneousClash, getActiveProgressionTier } from "./matchManager.js";
import { buildPool, allocateTeams } from "./teamSelection.js";

const db = await loadCardDatabase("./naruto_trump_battle_180_cards_anime_accurate.json");
const { A, B } = allocateTeams(buildPool(db, { preset: "quick", mode: "balanced", seed: "resume" }));
const mk = () => createMatchState({
  presetKey: "quick",
  teamA: { name: "A", cards: A, captainId: A[9].card_id, viceCaptainId: A[8].card_id },
  teamB: { name: "B", cards: B, captainId: B[9].card_id, viceCaptainId: B[8].card_id },
});
// same logic as passAndPlay.js snapshotMatchState / restoreMatchState
const snapshot = (m) => { const { history, preset, ...rest } = m; return { ...JSON.parse(JSON.stringify(rest)), presetKey: preset.key }; };
const restore = (s) => { const { presetKey, ...rest } = s; return { ...rest, preset: MATCH_PRESETS[presetKey], history: [] }; };

const stats = ["spd", "acc", "dur", "adp"];
function play(m, i) {
  const t = getActiveProgressionTier(m);
  const a = m.players.A.roster.find((c) => getCardTier(c) === t && !m.players.A.usedCardIds.includes(c.card_id));
  const b = m.players.B.roster.find((c) => getCardTier(c) === t && !m.players.B.usedCardIds.includes(c.card_id));
  return executeSimultaneousClash(m, {
    moveA: { cardId: a.card_id, style: "tai", basicStat: stats[i % 4] },
    moveB: { cardId: b.card_id, style: "nin", basicStat: stats[(i + 1) % 4] },
  });
}

const orig = mk();
for (let i = 0; i < 4; i++) play(orig, i);
const restored = restore(JSON.parse(JSON.stringify(snapshot(orig)))); // simulate save -> reload
while (orig.status === "IN_PROGRESS") {
  const i = orig.turn;
  play(orig, i); play(restored, i);
}
const same = JSON.stringify([orig.players, orig.winner, orig.status, orig.turn]) === JSON.stringify([restored.players, restored.winner, restored.status, restored.turn]);
if (!same) throw new Error("restored match diverged from the original");
console.log("PASS  Saved + restored match continues identically to the original (winner: " + orig.winner + ")");
