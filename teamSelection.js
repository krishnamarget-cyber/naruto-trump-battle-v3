// teamSelection.js — Team Selection Logic (5 Styles incl. Genjutsu + Balanced Best + Default/Intense Pool Filter)
import { TIERS, CardDatabaseError } from "./cardLoader.js";

export const PRE = Object.freeze({
  quick: Object.freeze([2, 2, 2, 2, 1, 1]),    // 10 cards/team
  standard: Object.freeze([3, 3, 3, 3, 2, 1]), // 15 cards/team
  marathon: Object.freeze([4, 4, 4, 4, 3, 1]), // 20 cards/team
});

// All 5 combat styles (including Genjutsu gen_atk)
const S = ["tai_atk", "nin_atk", "gen_atk", "kun_atk", "special_atk"];
const OTHER_4 = ["tai_atk", "nin_atk", "kun_atk", "special_atk"];
const P3 = ["tai_atk", "kun_atk", "nin_atk", "gen_atk", "special_atk"];

export function seeded(s) {
  let x = 0;
  for (const c of s) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return () => {
    x += 0x6D2B79F5;
    let t = x;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sh(a, rand = Math.random) {
  a = [...a];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function v(c, k) {
  return +(c[k] || 0);
}

function uniq(a) {
  return [...new Map(a.map((c) => [c.card_id, c])).values()];
}

export function phase12(cs, m, rand = Math.random) {
  const styles =
    m === "balanced"
      ? S
      : m === "dynamic"
      ? sh(S, rand).slice(0, 3)
      : ["tai_atk", "kun_atk", "nin_atk", "gen_atk", "special_atk"];

  let g = [];
  const H = {};
  const C = {};

  for (const s of styles) {
    const a = [...cs].sort((x, y) => (m === "weakest" ? v(x, s) - v(y, s) : v(y, s) - v(x, s)));
    const used = new Set();
    const sel = [];
    let hold = [];
    const con = [];
    let cur = 1;
    const p1 = a[0];

    if (p1) {
      sel.push(p1);
      used.add(p1.card_id);
    }

    let p2 = null;
    let skip = [];
    for (let i = 1; i <= Math.min(4, a.length - 1); i++) {
      const c = a[i];
      cur = i + 1;
      if (v(c, s) !== v(p1, s)) {
        p2 = c;
        break;
      }
      skip.push(c);
    }

    if (!p2 && a.length > 1) {
      p2 = a[Math.min(4, a.length - 1)];
      cur = Math.min(5, a.length);
      skip = a.slice(1, cur - 1);
    }

    for (const c of skip) {
      if (!used.has(c.card_id)) {
        con.push(c);
        used.add(c.card_id);
      }
    }
    if (p2 && !used.has(p2.card_id)) {
      sel.push(p2);
      used.add(p2.card_id);
    }

    let prev = p2 || p1;
    for (let n = 0; n < 3; n++) {
      let got = null;
      for (let j = 0; j < 3 && cur < a.length; j++) {
        const c = a[cur++];
        if (used.has(c.card_id)) continue;
        if (v(c, s) !== v(prev, s)) {
          got = c;
          break;
        }
        con.push(c);
        used.add(c.card_id);
      }
      if (!got) got = a.slice(cur).find((c) => !used.has(c.card_id));
      if (got && !used.has(got.card_id)) {
        hold.push(got);
        used.add(got.card_id);
        prev = got;
      }
    }

    if (hold.length) {
      const promoted = sh(hold, rand)[0];
      sel.push(promoted);
      hold = hold.filter((c) => c.card_id !== promoted.card_id);
    }

    g.push(...sel);
    H[s] = hold;
    C[s] = con;
  }

  const target = Math.min(m === "balanced" ? 14 : 10, cs.length);
  g = uniq(g);
  if (g.length > target) g = sh(g, rand).slice(0, target);
  for (const c of sh(cs, rand)) {
    if (g.length < target && !g.some((x) => x.card_id === c.card_id)) g.push(c);
  }

  return { g1: g, H, C, styles };
}

export function buildTier(cs, m, rand = Math.random) {
  const p = phase12(cs, m, rand);
  const g1 = p.g1;
  const used = new Set(g1.map((c) => c.card_id));
  const av = cs.filter((c) => !used.has(c.card_id));
  let g2 = [];

  for (const s of P3) {
    const ref =
      (p.H[s] || [])[2] ||
      [...cs].sort((a, b) => (m === "weakest" ? v(a, s) - v(b, s) : v(b, s) - v(a, s)))[0];
    const b = v(ref, s);
    const cand = av
      .filter((c) => (m === "weakest" ? v(c, s) > b : v(c, s) < b))
      .sort((a, b) => v(a, s) - v(b, s));
    const vals = [...new Set(cand.map((c) => v(c, s)))].sort((a, b) => a - b);
    const gaps = vals
      .slice(1)
      .map((x, i) => ({ gap: x - vals[i], cut: vals[i] }))
      .sort((a, b) => b.gap - a.gap);
    const cuts = gaps
      .slice(0, 2)
      .map((x) => x.cut)
      .sort((a, b) => a - b);
    const bands = [[], [], []];

    for (const c of cand) {
      const x = v(c, s);
      const i =
        cuts.length === 0
          ? 0
          : cuts.length === 1
          ? x <= cuts[0]
            ? 0
            : 2
          : x <= cuts[0]
          ? 0
          : x <= cuts[1]
          ? 1
          : 2;
      bands[i].push(c);
    }

    const top = sh([...(m === "weakest" ? bands[0] : bands[2]), ...bands[1]], rand).slice(0, 4);
    for (const c of sh(av, rand)) {
      if (top.length < 4 && !top.some((x) => x.card_id === c.card_id)) top.push(c);
    }

    const low = sh(m === "weakest" ? bands[2] : bands[0], rand)
      .filter((c) => !top.some((x) => x.card_id === c.card_id))
      .slice(0, 2);
    for (const c of sh(av, rand)) {
      if (
        low.length < 2 &&
        !top.some((x) => x.card_id === c.card_id) &&
        !low.some((x) => x.card_id === c.card_id)
      ) {
        low.push(c);
      }
    }

    for (const c of [...top, ...low]) {
      if (!g2.some((x) => x.card_id === c.card_id)) g2.push(c);
    }
  }

  g2 = sh(uniq(g2), rand).slice(0, Math.min(6, cs.length - g1.length));
  for (const c of sh(av, rand)) {
    if (g2.length < Math.min(6, cs.length - g1.length) && !g2.some((x) => x.card_id === c.card_id)) {
      g2.push(c);
    }
  }

  const bonus = [];
  const hp = sh(
    Object.values(p.H)
      .flat()
      .filter((c) => !used.has(c.card_id) && !g2.some((x) => x.card_id === c.card_id)),
    rand
  );
  const cp = sh(
    Object.values(p.C)
      .flat()
      .filter((c) => !used.has(c.card_id) && !g2.some((x) => x.card_id === c.card_id)),
    rand
  );
  if (hp[0]) bonus.push(hp[0]);
  const cc = cp.find((c) => !bonus.some((x) => x.card_id === c.card_id));
  if (cc) bonus.push(cc);
  for (const c of sh(av, rand)) {
    if (bonus.length < 2 && !g2.some((x) => x.card_id === c.card_id) && !bonus.some((x) => x.card_id === c.card_id)) {
      bonus.push(c);
    }
  }

  const total = Math.min(m === "balanced" ? 22 : 18, cs.length);
  const want = total - g1.length;
  g2 = uniq([...g2, ...bonus]).slice(0, want);
  for (const c of sh(av, rand)) {
    if (g2.length < want && !g1.some((x) => x.card_id === c.card_id) && !g2.some((x) => x.card_id === c.card_id)) {
      g2.push(c);
    }
  }

  return { group1: g1, group2: g2, pool: uniq([...g1, ...g2]), styles: p.styles };
}

/**
 * Balanced Best Teams Selection:
 * - Phase 1: Top 3 players for each of the 4 non-Genjutsu combat stats (4 x 3 = 12 slots)
 *           + Top 2 players for Genjutsu (2 slots).
 * - Phase 2: Within each of the 5 combat stats, pick 1 player above the tier average (5 slots).
 * - Total target pool per tier = 4*3 + 2 + 5 = 19 slots (top-ups only if deduplicated count < remaining cards).
 */
export function buildBalancedBestTier(cs, rand = Math.random) {
  const all = uniq(cs);
  const pickedIds = new Set();

  const pickNextBestUnique = (statKey, count) => {
    const ranked = [...all].sort(
      (a, b) => v(b, statKey) - v(a, statKey) || String(a.card_id).localeCompare(String(b.card_id))
    );
    const chosen = [];
    for (const card of ranked) {
      if (chosen.length >= count) break;
      if (!pickedIds.has(card.card_id)) {
        pickedIds.add(card.card_id);
        chosen.push(card);
      }
    }
    return chosen;
  };

  // Phase 1: For each of the 4 non-Genjutsu combat stats, pick top 3 unique cards (skipping any already picked)
  // + top 2 unique cards for Genjutsu (gen_atk).
  const group1 = [];
  for (const s of OTHER_4) {
    group1.push(...pickNextBestUnique(s, 3));
  }
  group1.push(...pickNextBestUnique("gen_atk", 2));

  // Phase 2: Within each of the 5 combat stats, pick 1 unique card above the tier average (or next best if needed)
  const group2 = [];
  for (const s of S) {
    const avg = all.reduce((acc, c) => acc + v(c, s), 0) / (all.length || 1);
    const aboveRanked = [...all]
      .filter((c) => !pickedIds.has(c.card_id) && v(c, s) > avg)
      .sort((a, b) => v(b, s) - v(a, s) || String(a.card_id).localeCompare(String(b.card_id)));

    if (aboveRanked[0]) {
      pickedIds.add(aboveRanked[0].card_id);
      group2.push(aboveRanked[0]);
    } else {
      const nextBest = pickNextBestUnique(s, 1);
      group2.push(...nextBest);
    }
  }

  // Top up up to target pool size of 19 only with unused unique cards if needed
  const targetPoolSize = Math.min(19, all.length);
  if (pickedIds.size < targetPoolSize) {
    for (const c of sh(all, rand)) {
      if (pickedIds.size >= targetPoolSize) break;
      if (!pickedIds.has(c.card_id)) {
        pickedIds.add(c.card_id);
        group2.push(c);
      }
    }
  }

  return {
    group1,
    group2,
    pool: uniq([...group1, ...group2]).slice(0, targetPoolSize),
    styles: [...S],
  };
}

export function buildRandomTier(cs, rand = Math.random) {
  const shuffled = sh(uniq(cs), rand);
  const half = Math.floor(shuffled.length / 2);
  return {
    group1: shuffled.slice(0, half),
    group2: shuffled.slice(half),
    pool: shuffled,
    styles: [...S],
  };
}

/**
 * Filter method on a tier:
 * - "default": no filter (returns tier as built)
 * - "intense": takes 10 cards from phase 1 (group1) and 2 cards from phase 2 (group2) -> 12-card pool
 */
export function applyTierFilter(tierObj, filterMode = "default", rand = Math.random) {
  if (filterMode !== "intense") {
    return tierObj;
  }
  const g1 = uniq(tierObj.group1 || []);
  const g2 = uniq((tierObj.group2 || []).filter((c) => !g1.some((x) => x.card_id === c.card_id)));
  const pool = uniq(tierObj.pool || [...g1, ...g2]);

  const pickedP1 = sh(g1, rand).slice(0, 10);
  const pickedP1Ids = new Set(pickedP1.map((c) => c.card_id));
  const remPool = sh(pool.filter((c) => !pickedP1Ids.has(c.card_id)), rand);
  const pickedP2 = sh(g2, rand).filter((c) => !pickedP1Ids.has(c.card_id)).slice(0, 2);

  for (const c of remPool) {
    if (pickedP2.length >= 2) break;
    if (!pickedP2.some((x) => x.card_id === c.card_id)) pickedP2.push(c);
  }

  return {
    group1: pickedP1,
    group2: pickedP2,
    pool: uniq([...pickedP1, ...pickedP2]),
    styles: tierObj.styles || [...S],
  };
}

export function buildPool(db, { preset = "standard", mode = "balanced", filterMode = "default", seed = "" } = {}) {
  if (!PRE[preset]) {
    throw new CardDatabaseError(`Invalid preset: ${JSON.stringify(preset)}. Expected quick, standard, or marathon.`);
  }
  const cleanSeed = String(seed || "").trim();
  const rand = cleanSeed ? seeded(cleanSeed) : Math.random;
  const tiers = {};
  for (const t of TIERS) {
    const rawTier =
      mode === "random"
        ? buildRandomTier(db.getCardsByTier(t), rand)
        : mode === "balanced_best"
        ? buildBalancedBestTier(db.getCardsByTier(t), rand)
        : buildTier(db.getCardsByTier(t), mode, rand);
    tiers[t] = applyTierFilter(rawTier, filterMode, rand);
  }
  return { mode, filterMode, preset, seed: cleanSeed || null, tiers, allocation: null, _rand: rand };
}

export function allocateTeams(buildResult) {
  if (!buildResult || !buildResult.tiers) {
    throw new CardDatabaseError("Call buildPool() before allocateTeams().");
  }
  const rand = buildResult._rand || Math.random;
  const n = PRE[buildResult.preset];
  const A = [];
  const B = [];
  const errs = [];

  for (let i = 0; i < TIERS.length; i++) {
    const t = TIERS[i];
    const need = n[i];
    if (need > 5) {
      errs.push(`${t} requires ${need}, exceeding max 5 per tier/team`);
      continue;
    }
    // Shuffle the full ready tier pool into a stack and deal alternately:
    // top -> Team A, next -> Team B, next -> Team A, next -> Team B, discarding each dealt card from the stack.
    const stack = sh(uniq(buildResult.tiers[t].pool || []), rand);
    if (stack.length < 2 * need) {
      errs.push(`${t} has ${stack.length}, requires ${need * 2} for both teams`);
      continue;
    }
    for (let k = 0; k < need; k++) {
      const cardForA = stack.shift();
      const cardForB = stack.shift();
      A.push(cardForA);
      B.push(cardForB);
    }
  }

  if (errs.length) {
    throw new CardDatabaseError(errs.join("; "));
  }

  buildResult.allocation = { A, B };
  return buildResult.allocation;
}
