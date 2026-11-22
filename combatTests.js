// combatTests.js — V2.2 Verification Tests (5 Styles incl. Genjutsu + Simultaneous Dual-Attack)
import { resolveClash, resolveSimultaneousTurn } from "./combatEngine.js";

function card(card_id, character_version, overrides) {
  return {
    card_id, character_version,
    spd: 50, acc: 50, dur: 50, adp: 50,
    kun_atk: 50, kun_def: 50, tai_atk: 50, tai_def: 50,
    nin_atk: 50, nin_def: 50, gen_atk: 50, gen_def: 50, special_atk: 50, special_def: 50,
    ...overrides,
  };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function eq(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

test("Test 1 — L3 Rock Lee vs Gaara (Cascading Speed Fallback + Tied Guard)", () => {
  const r = resolveClash({
    attacker: card("L3-007", "Rock Lee", { spd: 58, tai_atk: 58, adp: 46 }),
    defender: card("L3-005", "Gaara", { spd: 40, tai_def: 58, adp: 42 }),
    style: "tai", atkChoice: "spd", defChoice: "adp",
  });
  eq(r.branch, "GUARD_HOLDS", "branch");
  eq(r.atkModifierTriggered, "SPD_BLINDSPOT", "atk modifier");
  eq(r.damageToDefender, 9, "damage");
  eq(r.counterDamageToAttacker, 0, "counter");
});

test("Test 2 — Genjutsu Style Clash (L5 Edo Itachi vs Killer B)", () => {
  const r = resolveClash({
    attacker: card("L5-006", "Edo Itachi", { acc: 82, gen_atk: 84 }),
    defender: card("L5-018", "Killer B", { gen_def: 76, dur: 82 }),
    style: "gen", atkChoice: "acc", defChoice: "dur",
  });
  eq(r.branch, "DIRECT_BREAKTHROUGH", "branch");
  eq(r.atkModifierTriggered, "ACC_CRITICAL", "atk mod");
  eq(r.defModifierTriggered, "DUR_HEAVY_TANK", "def mod");
  eq(r.damageToDefender, 11, "damage: base 10 + 6 ACC elite = 16, DUR 30% cap -> floor(11.2) = 11");
});

test("Test 3 — Simultaneous Dual-Attack (Both Players Pick Style + 1 of 4 Basic Stats)", () => {
  const itachi = card("L5-006", "Edo Itachi", { spd: 76, acc: 82, dur: 78, adp: 82, gen_atk: 84, tai_def: 74 });
  const naruto = card("L5-002", "KCM1 Naruto", { spd: 82, acc: 74, dur: 78, adp: 76, tai_atk: 76, gen_def: 72 });
  const sim = resolveSimultaneousTurn({
    cardA: itachi, styleA: "gen", basicStatA: "acc",
    cardB: naruto, styleB: "tai", basicStatB: "spd",
  });
  eq(sim.attackAtoB.damageToDefender, 18, "Itachi GEN: base 12 + 6 ACC elite");
  eq(sim.attackBtoA.damageToDefender, 6, "Naruto TAI breakthrough");
});

test("DUR never cuts more than 30%", () => {
  // base 4 + ceil(30/1.5) = 24 dmg; defender DUR elite passes
  const r = resolveClash({
    attacker: card("L6-001", "A", { tai_atk: 80, dur: 50 }),
    defender: card("L6-002", "D", { tai_def: 50, dur: 99 }),
    style: "tai", atkChoice: "spd", defChoice: "dur",
  });
  eq(r.damageToDefender, 16, "24 * 0.70 floored = 16");
});

test("ADP never fires in DIRECT_BREAKTHROUGH, DUR never in GUARD_HOLDS", () => {
  const b = resolveClash({
    attacker: card("L2-001", "A", { tai_atk: 40 }), defender: card("L2-002", "D", { tai_def: 30, adp: 99 }),
    style: "tai", atkChoice: "spd", defChoice: "adp",
  });
  eq(b.defModifierTriggered, "NONE", "adp in breakthrough");
  const g = resolveClash({
    attacker: card("L2-001", "A", { tai_atk: 30, spd: 80 }), defender: card("L2-002", "D", { tai_def: 40, dur: 99 }),
    style: "tai", atkChoice: "spd", defChoice: "dur",
  });
  eq(g.defModifierTriggered, "NONE", "dur in guard hold");
});


test("ADP Tactical Read requires strict DEF > ATK and incoming damage > 0", () => {
  // Tie DEF == ATK -> ADP does not trigger
  const tie = resolveClash({
    attacker: card("L2-001", "A", { tai_atk: 35, spd: 40, adp: 30 }),
    defender: card("L2-002", "D", { tai_def: 35, spd: 20, adp: 45 }),
    style: "tai", atkChoice: "spd", defChoice: "adp",
  });
  eq(tie.defModifierTriggered, "NONE", "adp on tie");
  eq(tie.counterDamageToAttacker, 0, "counter on tie");

  // DEF > ATK, but attacker chose ACC (0 incoming damage) -> ADP Tactical Read does not trigger
  const zeroIncoming = resolveClash({
    attacker: card("L2-001", "A", { tai_atk: 30, adp: 30 }),
    defender: card("L2-002", "D", { tai_def: 40, adp: 35 }),
    style: "tai", atkChoice: "acc", defChoice: "adp",
  });
  eq(zeroIncoming.defModifierTriggered, "NONE", "adp on 0 incoming");
  eq(zeroIncoming.counterDamageToAttacker, 0, "counter on 0 incoming");

  // DEF > ATK, SPD Glance deals 1 dmg -> ADP Tactical Read triggers (-20% cut -> 1 dmg, +1 counter)
  const validRead = resolveClash({
    attacker: card("L2-001", "A", { tai_atk: 30, spd: 32, adp: 30 }),
    defender: card("L2-002", "D", { tai_def: 40, spd: 30, adp: 34 }),
    style: "tai", atkChoice: "spd", defChoice: "adp",
  });
  eq(validRead.defModifierTriggered, "ADP_TACTICAL_READ", "valid tactical read");
  eq(validRead.counterDamageToAttacker, 1, "valid tactical read counter");
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
