// passAndPlay.js — V2.7 Controller (Pass & Play + Room Code Online Multiplayer + DUR Max 30% Cap + Tier Signals + 60fps VFX)
import { TIERS, createCardDatabase, getCardTier } from "./cardLoader.js";
import { TIER_RULES_CONFIG } from "./combatEngine.js";
import {
  MATCH_PRESETS,
  SHIELD_MAX_CAPACITY,
  createMatchState,
  getActiveProgressionTier,
  activateShield,
  executeSimultaneousClash,
  getFiveRoundStatProgress,
  isBasicStatAllowedInFiveRounds,
  FIVE_ROUND_MIN_DISTINCT_STATS,
  FIVE_ROUND_MAX_SAME_STAT,
  getStyleExplorationStatus,
} from "./matchManager.js";
import { buildPool, allocateTeams } from "./teamSelection.js";
import { buildCardPortraitDataUrl } from "./portraitGenerator.js";
import { BattleFxEngine } from "./battleFx.js";
import { RoomMultiplayerClient } from "./roomClientAuto.js";
import { chooseComputerLeaders, chooseComputerMove } from "./computerAi.js";

const STAT_KEYS = [
  "spd", "acc", "dur", "adp",
  "tai_atk", "tai_def",
  "nin_atk", "nin_def",
  "gen_atk", "gen_def",
  "kun_atk", "kun_def",
  "special_atk", "special_def",
];

const STYLE_LABELS = {
  tai: "Taijutsu (TAI)",
  nin: "Ninjutsu (NIN)",
  gen: "Genjutsu (GEN)",
  kun: "Kenjutsu (KUN)",
  special: "Special (SPC)",
};

const BASIC_STAT_LABELS = {
  spd: { name: "SPD", role: "Guard Hold Offense" },
  acc: { name: "ACC", role: "Breakthrough Offense" },
  dur: { name: "DUR", role: "Breakthrough Defense (Max 30%)" },
  adp: { name: "ADP", role: "Guard Hold Defense" },
};

let db = null;
let tierAverages = {};
let draftedTeams = null;
let matchState = null;
let lastClashRecord = null;
let animTimers = [];
let sfxEnabled = true;

// Play mode: "pass_and_play" | "online_room" | "vs_computer"
let playMode = "pass_and_play";
let aiDifficulty = "hard"; // "medium" (80% best) | "hard" (100% best)
const roomClient = new RoomMultiplayerClient();
let lastAppliedOnlineTurn = 0;

// ---------------------------------------------------------------------------
// Match resume (Firebase mode): host saves the match after every change; a
// refreshed host reloads it, and a rejoining guest is re-synced by the host.
// ---------------------------------------------------------------------------
function snapshotMatchState() {
  const { history, preset, ...rest } = matchState;
  return { ...JSON.parse(JSON.stringify(rest)), explorationMode: getActiveExplorationMode(), presetKey: preset.key };
}

function restoreMatchState(snap) {
  const { presetKey, ...rest } = snap;
  if (!MATCH_PRESETS[presetKey]) throw new Error(`Unknown preset in saved match: ${presetKey}`);
  return { ...rest, explorationMode: rest.explorationMode || snap.explorationMode || getActiveExplorationMode(), preset: MATCH_PRESETS[presetKey], history: [] };
}

function persistOnlineState() {
  if (!isOnline() || roomClient.role !== "HOST" || !matchState) return;
  if (matchState.status === "FINISHED") {
    roomClient.clearState?.();
  } else {
    roomClient.saveState?.(snapshotMatchState());
  }
}

function sendResync() {
  if (roomClient.role !== "HOST" || !matchState || matchState.status === undefined) return;
  roomClient.send({
    type: "RESYNC_STATE",
    state: snapshotMatchState(),
    remoteLocked: Boolean(remoteMoveBuffer),
  });
}

function handleResync(msg) {
  const snap = msg.state;
  const upToDate = matchState && matchState.turn === snap.turn && matchState.status === snap.status;
  if (upToDate) {
    // Already in sync; only restore the "my move is locked" state if the host still holds it.
    if (msg.remoteLocked && !myMoveLockedOnline && snap.status === "IN_PROGRESS") {
      myMoveLockedOnline = true;
      $("turnControls").classList.add("hidden");
      $("turnCurtain").classList.remove("hidden");
      $("btnRevealTurn").classList.add("hidden");
      $("turnCurtainTitle").textContent = "Move Locked Privately!";
      $("turnCurtainSub").textContent = "Reconnected. Waiting for the clash to resolve...";
    }
    return;
  }
  matchState = restoreMatchState(snap);
  lastAppliedOnlineTurn = snap.turn - 1;
  myMoveLockedOnline = false;
  selectedCardId = null;
  showScreen("screenArena");
  updateHud();
  if (snap.status === "FINISHED") {
    advanceTurn();
    return;
  }
  prepareOnlineTurnUi();
  if (msg.remoteLocked) {
    myMoveLockedOnline = true;
    $("turnControls").classList.add("hidden");
    $("btnRevealTurn").classList.add("hidden");
    $("turnCurtainTitle").textContent = "Move Locked Privately!";
    $("turnCurtainSub").textContent = "Reconnected. Waiting for the clash to resolve...";
  }
  renderHistoryLog();
}

async function offerHostResume() {
  const saved = await roomClient.loadState?.();
  if (!saved || saved.status !== "IN_PROGRESS") return false;
  const where = `Turn ${saved.turn}, ${saved.players?.A?.name ?? "A"} vs ${saved.players?.B?.name ?? "B"}`;
  if (!confirm(`A saved match was found in this room (${where}).\n\nOK = resume it\nCancel = start fresh`)) {
    await roomClient.clearState?.();
    return false;
  }
  matchState = restoreMatchState(saved);
  lockedMoveA = null;
  remoteMoveBuffer = null;
  myMoveLockedOnline = false;
  selectedCardId = null;
  showScreen("screenArena");
  updateHud();
  prepareOnlineTurnUi();
  renderHistoryLog();
  if (roomClient.connected) sendResync();
  return true;
}
let remoteMoveBuffer = null;     // Guest move received by Host during current turn
let myMoveLockedOnline = false;  // Whether local player already locked their move this turn

// Leader selection temporary state
let leaderDraftStep = "A";
let tempCapA = null;
let tempVcA = null;
let tempCapB = null;
let tempVcB = null;

// Simultaneous turn state (Pass & Play)
let pickStep = "P1_PICK"; // "P1_PICK" -> "P2_PICK" -> "CLASH_REVEAL"
let selectedCardId = null;
let selectedStyle = "tai";
let selectedBasicStat = "spd";
let lockedMoveA = null;

const $ = (id) => document.getElementById(id);
const fxEngine = new BattleFxEngine($("fxCanvas"), $("battleStage"));

function isOnline() {
  return playMode === "online_room";
}

function isVsComputer() {
  return playMode === "vs_computer";
}

function mySide() {
  if (isVsComputer()) return "A";
  if (!isOnline()) return pickStep === "P1_PICK" ? "A" : "B";
  return roomClient.role === "HOST" ? "A" : "B";
}

function clearAnimTimers() {
  animTimers.forEach((id) => clearTimeout(id));
  animTimers = [];
  fxEngine.clear();
}

function showScreen(screenId) {
  clearAnimTimers();
  ["screenSetup", "screenLeaders", "screenArena"].forEach((id) => {
    $(id).classList.toggle("hidden", id !== screenId);
  });
  $("btnRestartTop").classList.toggle("hidden", screenId === "screenSetup");
}

function computeTierAverages(rawCards) {
  const buckets = {};
  for (const t of TIERS) buckets[t] = [];
  for (const c of rawCards) {
    const t = getCardTier(c);
    if (buckets[t]) buckets[t].push(c);
  }
  const avgs = {};
  for (const t of TIERS) {
    const list = buckets[t];
    avgs[t] = {};
    for (const k of STAT_KEYS) {
      const sum = list.reduce((acc, card) => acc + Number(card[k] || 0), 0);
      avgs[t][k] = list.length ? sum / list.length : 0;
    }
  }
  return avgs;
}

function formatStatSignal(val, tier, statKey) {
  const avg = tierAverages[tier]?.[statKey];
  if (typeof avg !== "number") return `<b>${val}</b>`;
  const diff = val - avg;
  let cls = "mid";
  let arrowCls = "sig-mid";
  let symbol = "•";

  if (diff >= 4) {
    cls = "star";
    arrowCls = "sig-star";
    symbol = "▲";
  } else if (diff > 0.5) {
    cls = "high";
    arrowCls = "sig-high";
    symbol = "▲";
  } else if (diff < -0.5) {
    cls = "low";
    arrowCls = "sig-low";
    symbol = "▼";
  }

  const sign = diff >= 0 ? `+${diff.toFixed(1)}` : diff.toFixed(1);
  const tip = `${val} vs ${tier} avg ${avg.toFixed(1)} (${sign})`;
  return `<span class="stat-val ${cls}" title="${tip}">${val}<span class="sig-arrow ${arrowCls}">${symbol}</span></span>`;
}

function renderPresetSummary() {
  const key = $("presetSelect").value;
  const p = MATCH_PRESETS[key];
  $("presetSummary").innerHTML = `
    <strong>${p.name} Preset:</strong> ${p.totalCards} cards/team
    (${TIERS.map((t, i) => `${t}: ${p.distribution[i]}`).join(", ")}) ·
    <strong>Shared HP Pool:</strong> ${p.maxHp} HP ·
    <strong>DUR Cap:</strong> Max 30% DMG cut ·
    <strong>Shield (at 3.0 / 6.0):</strong> Heal +${p.shieldHeal} HP (or +${p.shieldOverheal} Armor at full HP)
  `;
}

async function initDatabase() {
  try {
    const resp = await fetch("./naruto_trump_battle_180_cards_anime_accurate.json");
    if (!resp.ok) throw new Error(`HTTP ${resp.status} while loading JSON`);
    const raw = await resp.json();
    db = createCardDatabase(raw);
    tierAverages = computeTierAverages(raw);
  } catch (err) {
    $("loadError").classList.remove("hidden");
    $("loadError").textContent =
      `Could not load naruto_trump_battle_180_cards_anime_accurate.json: ${err.message}. ` +
      `Ensure all files are in the same folder and opened via Acode's local server.`;
    $("btnDraftTeams").disabled = true;
  }
}

function getPortraitSrc(card) {
  return buildCardPortraitDataUrl(card);
}

function renderCardMarkup(card, { badgeHtml = "", extraClass = "", footerHtml = "", selectedRibbon = false, popupHtml = "" } = {}) {
  const portraitUrl = getPortraitSrc(card);
  const tier = getCardTier(card);
  const s = (k) => formatStatSignal(card[k], tier, k);

  return `
    <div class="game-card ${extraClass}" data-id="${card.card_id}">
      ${selectedRibbon ? '<div class="selected-ribbon">✓ SELECTED</div>' : ""}
      ${popupHtml}
      <div class="card-top-row">
        <img class="card-portrait" src="${portraitUrl}" alt="${card.character_version}" />
        <div class="card-header-info">
          <div class="card-title">${card.character_version}${badgeHtml}</div>
          <div class="card-meta">${card.card_id} · Tier ${tier}</div>
        </div>
      </div>
      <div class="stat-pills">
        <div class="stat-pill"><span class="stat-lbl">SPD</span>${s("spd")}</div>
        <div class="stat-pill"><span class="stat-lbl">ACC</span>${s("acc")}</div>
        <div class="stat-pill"><span class="stat-lbl">DUR</span>${s("dur")}</div>
        <div class="stat-pill"><span class="stat-lbl">ADP</span>${s("adp")}</div>
      </div>
      <div class="style-grid">
        <div class="style-cell"><span class="st-name">TAI</span><span>${s("tai_atk")} / ${s("tai_def")}</span></div>
        <div class="style-cell"><span class="st-name">NIN</span><span>${s("nin_atk")} / ${s("nin_def")}</span></div>
        <div class="style-cell"><span class="st-name">GEN</span><span>${s("gen_atk")} / ${s("gen_def")}</span></div>
        <div class="style-cell"><span class="st-name">KUN</span><span>${s("kun_atk")} / ${s("kun_def")}</span></div>
        <div class="style-cell"><span class="st-name">SPC</span><span>${s("special_atk")} / ${s("special_def")}</span></div>
      </div>
      ${footerHtml}
    </div>
  `;
}

// ============================================================================
// ROOM CODE MULTIPLAYER SYNC
// ============================================================================
function setRoomStatus(text, ok = false) {
  const el = $("roomConnStatus");
  el.textContent = text;
  el.style.background = ok ? "#065f46" : "#243656";
  el.style.color = ok ? "#a7f3d0" : "#edf2ff";
}

function updateRoomHeaderBadge() {
  const badge = $("roomHeaderBadge");
  if (isOnline() && roomClient.roomCode) {
    badge.classList.remove("hidden");
    badge.textContent = `ROOM: ${roomClient.roomCode} (${roomClient.role || "PEER"})`;
  } else {
    badge.classList.add("hidden");
  }
}

async function handleCreateRoom() {
  const custom = $("roomCodeInput").value.trim().toUpperCase();
  $("btnCreateRoom").disabled = true;
  setRoomStatus("Creating Room...");
  try {
    const code = await roomClient.createRoom(custom || null);
    $("roomCodeInput").value = code;
    updateRoomHeaderBadge();
    setRoomStatus(`HOST · Code: ${code}`, true);
    $("roomLobbyInfo").innerHTML =
      `Room <strong class="gold-text">${code}</strong> created! Share this code with Player 2, or click <b>Draft Teams</b> once they join.`;
    roomClient.send({
      type: "HELLO_HOST",
      hostName: $("playerAName").value.trim() || "Player 1",
    });
    await offerHostResume();
  } catch (err) {
    setRoomStatus("Room Error");
    $("roomLobbyInfo").textContent = err.message;
  } finally {
    $("btnCreateRoom").disabled = false;
  }
}

async function handleJoinRoom() {
  const code = $("roomCodeInput").value.trim().toUpperCase();
  if (!code) {
    $("roomLobbyInfo").textContent = "Enter the 6-letter Room Code from Player 1 first.";
    return;
  }
  $("btnJoinRoom").disabled = true;
  setRoomStatus("Joining...");
  try {
    await roomClient.joinRoom(code);
    updateRoomHeaderBadge();
    setRoomStatus(`GUEST · Code: ${code}`, true);
    $("roomLobbyInfo").innerHTML =
      `Joined room <strong class="blue-text">${code}</strong>! Waiting for Host to draft teams &amp; send rosters...`;
    roomClient.send({
      type: "HELLO_GUEST",
      guestName: $("playerBName").value.trim() || "Player 2",
    });
  } catch (err) {
    setRoomStatus("Join Failed");
    $("roomLobbyInfo").textContent = err.message;
  } finally {
    $("btnJoinRoom").disabled = false;
  }
}

roomClient.on("peer_connected", ({ transport }) => {
  setRoomStatus(`CONNECTED (${roomClient.role} · ${transport})`, true);
  updateRoomHeaderBadge();
  if (roomClient.role === "HOST") {
    roomClient.send({
      type: "HELLO_HOST",
      hostName: $("playerAName").value.trim() || "Player 1",
    });
    if (matchState && matchState.status === "IN_PROGRESS") sendResync();
  } else {
    roomClient.send({
      type: "HELLO_GUEST",
      guestName: $("playerBName").value.trim() || "Player 2",
    });
  }
});

roomClient.on("error", ({ message }) => {
  setRoomStatus("Room Error");
  $("roomLobbyInfo").textContent = message;
});

roomClient.on("peer_disconnected", () => {
  setRoomStatus("Peer Disconnected");
});

roomClient.on("message", (msg) => {
  if (!msg || !msg.type) return;

  if (msg.type === "HELLO_GUEST" && roomClient.role === "HOST") {
    if (msg.guestName) $("playerBName").value = msg.guestName;
    $("roomLobbyInfo").innerHTML =
      `Opponent <strong>${msg.guestName || "Player 2"}</strong> connected! Click <b>Draft Teams &amp; Assign Leaders</b> to begin.`;
  } else if (msg.type === "HELLO_HOST" && roomClient.role === "GUEST") {
    if (msg.hostName) $("playerAName").value = msg.hostName;
    $("roomLobbyInfo").innerHTML =
      `Connected to Host <strong>${msg.hostName || "Player 1"}</strong>! Waiting for draft...`;
  } else if (msg.type === "TEAM_DRAFT_SYNC" && roomClient.role === "GUEST") {
    selectedExplorationMode = msg.explorationMode || "default";
    draftedTeams = {
      presetKey: msg.presetKey,
      nameA: msg.nameA,
      nameB: msg.nameB,
      cardsA: msg.cardsA,
      cardsB: msg.cardsB,
    };
    tempCapB = null;
    tempVcB = null;
    $("curtainLeaderTitle").textContent = `Ready, ${draftedTeams.nameB}?`;
    $("curtainLeaderSub").textContent =
      `Host drafted ${draftedTeams.cardsB.length} cards for your team. Pick your Captain (2.0×) and Vice-Captain (1.5×).`;
    showScreen("screenLeaders");
    $("leaderCurtain").classList.remove("hidden");
    $("leaderPickerContent").classList.add("hidden");
  } else if (msg.type === "GUEST_LEADERS_LOCKED" && roomClient.role === "HOST") {
    tempCapB = msg.captainId;
    tempVcB = msg.viceCaptainId;
    if (draftedTeams && tempCapA && tempVcA) {
      startOnlineMatchAsHost();
    }
  } else if (msg.type === "START_ONLINE_MATCH" && roomClient.role === "GUEST") {
    if (msg.explorationMode) selectedExplorationMode = msg.explorationMode;
    matchState = createMatchState({
      presetKey: msg.presetKey,
      explorationMode: selectedExplorationMode,
      teamA: msg.teamA,
      teamB: msg.teamB,
    });
    myMoveLockedOnline = false;
    selectedCardId = null;
    showScreen("screenArena");
    updateHud();
    prepareOnlineTurnUi();
  } else if (msg.type === "GUEST_MOVE_LOCKED" && roomClient.role === "HOST") {
    if (!matchState || remoteMoveBuffer) return; // duplicate or no match yet
    if (msg.turn !== undefined && msg.turn !== matchState.turn) return; // stale
    remoteMoveBuffer = msg.move;
    if (myMoveLockedOnline && matchState && matchState.status === "IN_PROGRESS") {
      resolveOnlineTurnOnHost();
    } else {
      $("turnCurtainSub").textContent = `${matchState.players.B.name} locked their move! Now lock your move to resolve.`;
    }
  } else if (msg.type === "HOST_TURN_RESOLVED" && roomClient.role === "GUEST") {
    const rec = msg.record;
    if (rec.turn <= lastAppliedOnlineTurn) return; // duplicate delivery
    lastAppliedOnlineTurn = rec.turn;
    // Apply authoritative state snapshot from Host
    matchState.turn = msg.stateAfter.turn;
    matchState.activeTier = msg.stateAfter.activeTier;
    matchState.status = msg.stateAfter.status;
    matchState.winner = msg.stateAfter.winner;
    matchState.players.A.hp = msg.stateAfter.players.A.hp;
    matchState.players.A.extraArmorHp = msg.stateAfter.players.A.extraArmorHp;
    matchState.players.A.shields = msg.stateAfter.players.A.shields;
    matchState.players.A.usedCardIds = msg.stateAfter.players.A.usedCardIds;
    matchState.players.A.usedCombatStyles = msg.stateAfter.players.A.usedCombatStyles || [];
    matchState.players.A.basicStatHistory = msg.stateAfter.players.A.basicStatHistory || [];
    matchState.players.B.hp = msg.stateAfter.players.B.hp;
    matchState.players.B.extraArmorHp = msg.stateAfter.players.B.extraArmorHp;
    matchState.players.B.shields = msg.stateAfter.players.B.shields;
    matchState.players.B.usedCardIds = msg.stateAfter.players.B.usedCardIds;
    matchState.players.B.usedCombatStyles = msg.stateAfter.players.B.usedCombatStyles || [];
    matchState.players.B.basicStatHistory = msg.stateAfter.players.B.basicStatHistory || [];
    matchState.history.push(rec);

    myMoveLockedOnline = false;
    selectedCardId = null;
    runAnimatedBattleSimulation(rec);
  } else if (msg.type === "RESYNC_STATE" && roomClient.role === "GUEST") {
    handleResync(msg);
  } else if (msg.type === "MOVE_REJECTED" && roomClient.role === "GUEST") {
    myMoveLockedOnline = false;
    prepareOnlineTurnUi();
    $("turnCurtainSub").textContent = `Move rejected: ${msg.reason}`;
  } else if (msg.type === "SHIELD_SYNC") {
    if (!matchState) return;
    const ev = msg.event;
    const p = matchState.players[ev.playerSide];
    p.shields = ev.remainingShields;
    p.hp = ev.hp;
    p.extraArmorHp = ev.extraArmorHp;
    matchState.history.push(ev);
    persistOnlineState();
    updateHud();
    renderHistoryLog();
  }
});

// ============================================================================
// SCREEN 1 -> SCREEN 2: DRAFT & LEADER SELECTION
// ============================================================================
function startDraft() {
  if (!db) return;
  const preset = $("presetSelect").value;
  const mode = $("metaSelect").value;
  const filterMode = $("poolFilterSelect")?.value || "default";
  selectedExplorationMode = filterMode;
  const passFilterMode = filterMode === "intense" ? "intense" : "default";
  const seed = $("seedInput").value.trim() || (isOnline() ? `room-${roomClient.roomCode || Date.now()}` : "");

  const poolResult = buildPool(db, { preset, mode, filterMode: passFilterMode, seed });
  const { A, B } = allocateTeams(poolResult);
  const defaultBName = isVsComputer() ? `Computer (${aiDifficulty === "hard" ? "Hard" : "Medium 80%"})` : "Player 2";
  draftedTeams = {
    presetKey: preset,
    nameA: $("playerAName").value.trim() || "Player 1",
    nameB: ($("playerBName").value.trim() && $("playerBName").value.trim() !== "Player 2")
      ? $("playerBName").value.trim()
      : defaultBName,
    cardsA: A,
    cardsB: B,
  };

  tempCapA = null;
  tempVcA = null;
  tempCapB = null;
  tempVcB = null;

  if (isOnline()) {
    if (!roomClient.roomCode) {
      $("loadError").classList.remove("hidden");
      $("loadError").textContent = "Please Create or Join a Room Code first before drafting teams.";
      return;
    }
    $("loadError").classList.add("hidden");
    roomClient.role = roomClient.role || "HOST";
    updateRoomHeaderBadge();

    if (roomClient.role === "HOST") {
      roomClient.send({
        type: "TEAM_DRAFT_SYNC",
        presetKey: preset,
        nameA: draftedTeams.nameA,
        nameB: draftedTeams.nameB,
        cardsA: draftedTeams.cardsA,
        cardsB: draftedTeams.cardsB,
      });
      $("curtainLeaderTitle").textContent = `${draftedTeams.nameA} — Pick Your Leaders`;
      $("curtainLeaderSub").textContent = "Select your Captain (2.0×) and Vice-Captain (1.5×) privately on your device.";
      showScreen("screenLeaders");
      $("leaderCurtain").classList.remove("hidden");
      $("leaderPickerContent").classList.add("hidden");
    }
    return;
  }

  openLeaderCurtain("A");
  showScreen("screenLeaders");
}

function openLeaderCurtain(side) {
  leaderDraftStep = side;
  const pName = side === "A" ? draftedTeams.nameA : draftedTeams.nameB;
  $("curtainLeaderTitle").textContent = `Pass Device to ${pName}`;
  $("curtainLeaderSub").textContent =
    "Keep the screen hidden from your opponent while choosing your Captain (2.0×) and Vice-Captain (1.5×).";
  $("leaderCurtain").classList.remove("hidden");
  $("leaderPickerContent").classList.add("hidden");
}

function renderLeaderPicker() {
  const side = isOnline() ? (roomClient.role === "GUEST" ? "B" : "A") : leaderDraftStep;
  const pName = side === "A" ? draftedTeams.nameA : draftedTeams.nameB;
  const cards = side === "A" ? draftedTeams.cardsA : draftedTeams.cardsB;
  const capId = side === "A" ? tempCapA : tempCapB;
  const vcId = side === "A" ? tempVcA : tempVcB;

  $("leaderHeader").textContent = `${pName} — Select Captain & Vice-Captain`;
  $("leaderCountBadge").textContent = `${cards.length} Cards`;

  const capCard = cards.find((c) => c.card_id === capId);
  const vcCard = cards.find((c) => c.card_id === vcId);
  $("chosenCapLabel").textContent = capCard ? `${capCard.character_version} (${capCard.card_id})` : "None";
  $("chosenVcLabel").textContent = vcCard ? `${vcCard.character_version} (${vcCard.card_id})` : "None";

  if (isOnline()) {
    $("btnConfirmLeaders").textContent =
      roomClient.role === "HOST"
        ? "Lock My Leaders & Wait for Player 2"
        : "Lock My Leaders & Enter Arena";
  } else {
    $("btnConfirmLeaders").textContent =
      side === "A" ? `Confirm & Pass to ${draftedTeams.nameB}` : "Confirm & Start Battle at Tier L1!";
  }
  $("btnConfirmLeaders").disabled = !(capId && vcId && capId !== vcId);

  $("leaderRosterGrid").innerHTML = cards
    .map((c) => {
      const isCap = c.card_id === capId;
      const isVc = c.card_id === vcId;
      const badge = isCap
        ? '<span class="badge badge-cap">CAP 2×</span>'
        : isVc
        ? '<span class="badge badge-vc">VC 1.5×</span>'
        : "";
      const extraClass = isCap ? "cap-card selected" : isVc ? "vc-card selected" : "";
      const footer = `
        <div class="role-actions">
          <button type="button" data-role="cap" data-cid="${c.card_id}">${isCap ? "✓ Captain" : "Set Captain"}</button>
          <button type="button" data-role="vc" data-cid="${c.card_id}">${isVc ? "✓ Vice-Cap" : "Set Vice-Cap"}</button>
        </div>
      `;
      return renderCardMarkup(c, { badgeHtml: badge, extraClass, footerHtml: footer, selectedRibbon: isCap || isVc });
    })
    .join("");

  $("leaderRosterGrid").querySelectorAll("button[data-role]").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const cid = btn.dataset.cid;
      const role = btn.dataset.role;
      if (side === "A") {
        if (role === "cap") {
          tempCapA = cid;
          if (tempVcA === cid) tempVcA = null;
        } else {
          tempVcA = cid;
          if (tempCapA === cid) tempCapA = null;
        }
      } else {
        if (role === "cap") {
          tempCapB = cid;
          if (tempVcB === cid) tempVcB = null;
        } else {
          tempVcB = cid;
          if (tempCapB === cid) tempCapB = null;
        }
      }
      renderLeaderPicker();
    };
  });
}

function startOnlineMatchAsHost() {
  const teamADef = {
    name: draftedTeams.nameA,
    cards: draftedTeams.cardsA,
    captainId: tempCapA,
    viceCaptainId: tempVcA,
  };
  const teamBDef = {
    name: draftedTeams.nameB,
    cards: draftedTeams.cardsB,
    captainId: tempCapB,
    viceCaptainId: tempVcB,
  };

  matchState = createMatchState({ presetKey: draftedTeams.presetKey, explorationMode: selectedExplorationMode,
    teamA: teamADef,
    teamB: teamBDef,
  });

  roomClient.send({
    type: "START_ONLINE_MATCH",
    presetKey: draftedTeams.presetKey,
    explorationMode: selectedExplorationMode,
    teamA: teamADef,
    teamB: teamBDef,
  });
  persistOnlineState();

  myMoveLockedOnline = false;
  remoteMoveBuffer = null;
  selectedCardId = null;

  showScreen("screenArena");
  updateHud();
  prepareOnlineTurnUi();
}

function confirmLeaders() {
  if (isOnline()) {
    if (roomClient.role === "GUEST") {
      roomClient.send({
        type: "GUEST_LEADERS_LOCKED",
        captainId: tempCapB,
        viceCaptainId: tempVcB,
      });
      $("leaderPickerContent").classList.add("hidden");
      $("leaderCurtain").classList.remove("hidden");
      $("curtainLeaderTitle").textContent = "Leaders Locked!";
      $("curtainLeaderSub").textContent = "Waiting for Host to start the match...";
      $("btnRevealLeaders").classList.add("hidden");
    } else {
      if (tempCapB && tempVcB) {
        startOnlineMatchAsHost();
      } else {
        $("leaderPickerContent").classList.add("hidden");
        $("leaderCurtain").classList.remove("hidden");
        $("curtainLeaderTitle").textContent = "Leaders Locked!";
        $("curtainLeaderSub").textContent = "Waiting for Player 2 to confirm their Captain & Vice-Captain...";
        $("btnRevealLeaders").classList.add("hidden");
      }
    }
    return;
  }

  if (isVsComputer()) {
    const aiLeaders = chooseComputerLeaders(draftedTeams.cardsB, aiDifficulty, tierAverages);
    tempCapB = aiLeaders.captainId;
    tempVcB = aiLeaders.viceCaptainId;
    matchState = createMatchState({ presetKey: draftedTeams.presetKey, explorationMode: selectedExplorationMode,
      teamA: {
        name: draftedTeams.nameA,
        cards: draftedTeams.cardsA,
        captainId: tempCapA,
        viceCaptainId: tempVcA,
      },
      teamB: {
        name: draftedTeams.nameB,
        cards: draftedTeams.cardsB,
        captainId: tempCapB,
        viceCaptainId: tempVcB,
      },
    });
    pickStep = "P1_PICK";
    lockedMoveA = null;
    selectedCardId = null;
    showScreen("screenArena");
    updateHud();
    prepareTurnCurtain();
    return;
  }

  if (leaderDraftStep === "A") {
    openLeaderCurtain("B");
    return;
  }
  matchState = createMatchState({ presetKey: draftedTeams.presetKey, explorationMode: selectedExplorationMode,
    teamA: {
      name: draftedTeams.nameA,
      cards: draftedTeams.cardsA,
      captainId: tempCapA,
      viceCaptainId: tempVcA,
    },
    teamB: {
      name: draftedTeams.nameB,
      cards: draftedTeams.cardsB,
      captainId: tempCapB,
      viceCaptainId: tempVcB,
    },
  });

  pickStep = "P1_PICK";
  lockedMoveA = null;
  selectedCardId = null;

  showScreen("screenArena");
  updateHud();
  prepareTurnCurtain();
}

// ============================================================================
// SCREEN 3: TIER PROGRESSION & SIMULTANEOUS DUAL-ATTACK ARENA
// ============================================================================
function renderTierStepper() {
  const activeTier = getActiveProgressionTier(matchState);
  const activeIdx = activeTier ? TIERS.indexOf(activeTier) : TIERS.length;

  $("tierStepper").innerHTML = TIERS.map((t, idx) => {
    const cls = idx < activeIdx ? "done" : idx === activeIdx ? "active" : "";
    const pA = matchState.players.A;
    const totalInTier = pA.roster.filter((c) => getCardTier(c) === t).length;
    const usedInTier = pA.roster.filter((c) => getCardTier(c) === t && pA.usedCardIds.includes(c.card_id)).length;
    return `<div class="tier-step ${cls}">${t}<br>${usedInTier}/${totalInTier}</div>`;
  }).join("");

  if (activeTier) {
    const pA = matchState.players.A;
    const rem = pA.roster.filter((c) => getCardTier(c) === activeTier && !pA.usedCardIds.includes(c.card_id)).length;
    $("tierRemainingText").textContent = `Current Stage: Tier ${activeTier} (${rem} clash${rem > 1 ? "es" : ""} left in ${activeTier})`;
  } else {
    $("tierRemainingText").textContent = "All Tiers Cleared";
  }
}


let selectedExplorationMode = "default";

function getActiveExplorationMode() {
  return matchState?.explorationMode || selectedExplorationMode || "default";
}

function evaluateCombatStyleChoice(player, styleKey) {
  return getStyleExplorationStatus(player, styleKey, getActiveExplorationMode());
}

function isCombatStyleAllowed(player, styleKey) {
  return evaluateCombatStyleChoice(player, styleKey).allowed;
}

function syncStyleButtonsForPlayer(player) {
  const btns = $("styleBtnGroup").querySelectorAll("button");
  const mode = getActiveExplorationMode();
  if (mode === "default" || !player) {
    btns.forEach((b) => {
      b.disabled = false;
      b.title = "";
    });
    return;
  }
  let firstAllowed = null;
  btns.forEach((btn) => {
    const st = btn.dataset.style;
    const res = evaluateCombatStyleChoice(player, st);
    btn.disabled = !res.allowed;
    btn.title = res.reason || "";
    if (res.allowed && !firstAllowed) firstAllowed = st;
  });
  if (!isCombatStyleAllowed(player, selectedStyle) && firstAllowed) {
    selectedStyle = firstAllowed;
    btns.forEach((b) => b.classList.toggle("active", b.dataset.style === selectedStyle));
  }
}

function renderMyRosterStatus() {
  const container = $("myRosterStatusBody");
  const pill = $("rosterSummaryPill");
  if (!container || !pill || !matchState) return;
  const player = matchState.players[mySide()];
  if (!player) return;

  const usedSet = new Set(player.usedCardIds || []);
  const played = player.roster.filter((c) => usedSet.has(c.card_id));
  const notPlayed = player.roster.filter((c) => !usedSet.has(c.card_id));
  pill.textContent = `${played.length} Played · ${notPlayed.length} Not Played`;

  const cardTile = (c, isPlayed) => {
    const isCap = c.card_id === player.captainId;
    const isVc = c.card_id === player.viceCaptainId;
    const roleBadge = isCap
      ? '<span class="badge badge-cap">CAP 2×</span>'
      : isVc
      ? '<span class="badge badge-vc">VC 1.5×</span>'
      : "";
    const statusBadge = isPlayed
      ? '<span class="badge badge-used">PLAYED</span>'
      : '<span class="badge badge-vc" style="background:#065f46;color:#a7f3d0;">NOT PLAYED</span>';
    return renderCardMarkup(c, {
      badgeHtml: roleBadge + statusBadge,
      extraClass: isPlayed ? "used" : isCap ? "cap-card" : isVc ? "vc-card" : "",
    });
  };

  container.innerHTML = `
    <h3 class="ok" style="margin:6px 0;">Not Played (${notPlayed.length})</h3>
    <div class="card-grid">
      ${notPlayed.length ? notPlayed.map((c) => cardTile(c, false)).join("") : '<div class="muted">All cards played.</div>'}
    </div>
    <h3 class="muted" style="margin:12px 0 6px;">Played (${played.length})</h3>
    <div class="card-grid">
      ${played.length ? played.map((c) => cardTile(c, true)).join("") : '<div class="muted">No cards played yet.</div>'}
    </div>
  `;
}

function updateHud() {
  renderTierStepper();
  ["A", "B"].forEach((side) => {
    const p = matchState.players[side];
    $(`hudName${side}`).textContent = p.name;

    const statusEl = $(`hudStatus${side}`);
    if (isOnline()) {
      const isMe = (roomClient.role === "HOST" && side === "A") || (roomClient.role === "GUEST" && side === "B");
      if (pickStep === "CLASH_REVEAL") {
        statusEl.textContent = "RESOLVED";
        statusEl.className = "role-pill";
      } else if (isMe) {
        statusEl.textContent = myMoveLockedOnline ? "MOVE LOCKED" : "YOUR TURN";
        statusEl.className = `role-pill ${myMoveLockedOnline ? "locked" : "active"}`;
      } else {
        statusEl.textContent = "OPPONENT";
        statusEl.className = "role-pill";
      }
    } else if (pickStep === "P1_PICK") {
      statusEl.textContent = side === "A" ? "PICKING NOW" : "WAITING";
      statusEl.className = `role-pill ${side === "A" ? "active" : ""}`;
    } else if (pickStep === "P2_PICK") {
      statusEl.textContent = side === "A" ? "MOVE LOCKED" : "PICKING NOW";
      statusEl.className = `role-pill ${side === "B" ? "locked" : "active"}`;
    } else {
      statusEl.textContent = "RESOLVED";
      statusEl.className = "role-pill";
    }

    $(`hudHpText${side}`).textContent = `${p.hp} / ${p.maxHp} HP`;
    const armorEl = $(`hudArmorText${side}`);
    if (p.extraArmorHp > 0) {
      armorEl.textContent = `+${p.extraArmorHp} Armor`;
      armorEl.classList.remove("hidden");
    } else {
      armorEl.classList.add("hidden");
    }

    const hpPct = Math.max(0, Math.min(100, (p.hp / p.maxHp) * 100));
    $(`hudHpBar${side}`).style.width = `${hpPct}%`;

    $(`hudShieldText${side}`).textContent = `${p.shields.toFixed(1)} / ${SHIELD_MAX_CAPACITY.toFixed(1)}`;
    const shPct = Math.max(0, Math.min(100, (p.shields / SHIELD_MAX_CAPACITY) * 100));
    $(`hudShieldBar${side}`).style.width = `${shPct}%`;

    const isAllowedShield = !isOnline() || (roomClient.role === "HOST" && side === "A") || (roomClient.role === "GUEST" && side === "B");
    const canUseShield = isAllowedShield && matchState.status === "IN_PROGRESS" && p.shields >= 3.0 && pickStep !== "CLASH_REVEAL";
    $(`btnShield${side}`).disabled = !canUseShield;

    const remaining = p.roster.length - p.usedCardIds.length;
    $(`hudCardsLeft${side}`).textContent = `Total Cards Left: ${remaining} / ${p.roster.length}`;
  });
  renderMyRosterStatus();
}

function handleActivateShield(side) {
  if (!matchState || matchState.status !== "IN_PROGRESS") return;
  const ev = activateShield(matchState, side);
  if (isOnline()) {
    roomClient.send({ type: "SHIELD_SYNC", event: ev });
    persistOnlineState();
  }
  updateHud();
  renderHistoryLog();
  const p = matchState.players[side];
  alert(
    ev.mode === "HEAL"
      ? `${p.name} spent 3.0 Shields and healed +${ev.amountApplied} HP (${p.hp}/${p.maxHp} HP)!`
      : `${p.name} spent 3.0 Shields at full HP and gained +${ev.amountApplied} Extra Armor HP!`
  );
}

function prepareOnlineTurnUi() {
  const activeTier = getActiveProgressionTier(matchState);
  pickStep = "P1_PICK";
  myMoveLockedOnline = false;
  selectedCardId = null;

  $("turnBanner").textContent = `Turn ${matchState.turn} — Tier ${activeTier} Online Clash`;
  $("tierLockBadge").textContent = `Active Tier: ${activeTier}`;

  $("turnCurtainTitle").textContent = `Room ${roomClient.roomCode} — Tier ${activeTier}`;
  $("turnCurtainSub").textContent = "Reveal your private hand to choose your card, Attack Style, and 1 Basic Stat.";
  $("btnRevealTurn").classList.remove("hidden");

  $("turnCurtain").classList.remove("hidden");
  $("turnControls").classList.add("hidden");
  $("clashRevealPanel").classList.add("hidden");
  $("matchOverPanel").classList.add("hidden");
  updateHud();
}

function prepareTurnCurtain() {
  if (isOnline()) {
    prepareOnlineTurnUi();
    return;
  }
  const activeTier = getActiveProgressionTier(matchState);
  const activeSide = pickStep === "P1_PICK" ? "A" : "B";
  const activePlayer = matchState.players[activeSide];

  $("turnBanner").textContent = `Turn ${matchState.turn} — Tier ${activeTier} Simultaneous Clash`;
  $("tierLockBadge").textContent = `Active Tier: ${activeTier}`;

  $("turnCurtainTitle").textContent = `Pass Device to ${activePlayer.name}`;
  $("turnCurtainSub").textContent =
    pickStep === "P1_PICK"
      ? `Choose your ${activeTier} card, your Attack Style, and 1 of the 4 Basic Stats.`
      : `${matchState.players.A.name} has locked in a ${activeTier} move! Now choose your ${activeTier} card, Attack Style, and 1 Basic Stat.`;

  $("turnCurtain").classList.remove("hidden");
  $("turnControls").classList.add("hidden");
  $("clashRevealPanel").classList.add("hidden");
  $("matchOverPanel").classList.add("hidden");
  updateHud();
}


function updateFiveRoundStatButtons(player) {
  const btns = $("basicStatBtnGroup").querySelectorAll("button");
  if (!player) {
    btns.forEach((b) => { b.disabled = false; b.title = ""; });
    return;
  }
  const check = isBasicStatAllowedInFiveRounds(player, selectedBasicStat);
  const prog = check.progress;

  btns.forEach((btn) => {
    const st = btn.dataset.stat;
    const stCheck = isBasicStatAllowedInFiveRounds(player, st);
    btn.disabled = !stCheck.allowed;
    btn.title = stCheck.allowed
      ? `5-Round Block ${prog.blockNumber} (Rounds ${prog.blockStartTurn}–${prog.blockEndTurn}): ${prog.distinctCount}/3 distinct stats used (${prog.distinctStats.map((s) => s.toUpperCase()).join(", ") || "none"})`
      : stCheck.reason;
  });

  if (!check.allowed) {
    const firstAllowed = ["spd", "acc", "dur", "adp"].find((st) => isBasicStatAllowedInFiveRounds(player, st).allowed);
    if (firstAllowed) {
      selectedBasicStat = firstAllowed;
      btns.forEach((b) => b.classList.toggle("active", b.dataset.stat === selectedBasicStat));
    }
  }
}

function refreshMoveSelectorLabels(card) {
  const tier = card ? getCardTier(card) : null;

  const activeP = matchState ? matchState.players[mySide()] : null;
  syncStyleButtonsForPlayer(activeP);
  $("styleBtnGroup").querySelectorAll("button").forEach((btn) => {
    const st = btn.dataset.style;
    if (!card) {
      btn.innerHTML = `<span>${STYLE_LABELS[st]}</span>`;
      return;
    }
    const atkHtml = formatStatSignal(card[`${st}_atk`], tier, `${st}_atk`);
    const defHtml = formatStatSignal(card[`${st}_def`], tier, `${st}_def`);
    btn.innerHTML = `<span>${STYLE_LABELS[st]}</span><span class="btn-stat-sub">ATK ${atkHtml} · DEF ${defHtml}</span>`;
  });

  $("basicStatBtnGroup").querySelectorAll("button").forEach((btn) => {
    const st = btn.dataset.stat;
    const meta = BASIC_STAT_LABELS[st];
    if (!card) {
      btn.innerHTML = `<span>${meta.name}</span><span class="btn-stat-sub">${meta.role}</span>`;
      return;
    }
    const valHtml = formatStatSignal(card[st], tier, st);
    const cnt = matchState ? (getFiveRoundStatProgress(matchState.players[mySide()]).statCounts[st] || 0) : 0;
    btn.innerHTML = `<span>${meta.name} ${valHtml} <small class="muted">(${cnt}/3)</small></span><span class="btn-stat-sub">${meta.role}</span>`;
  });
}

function updateSelectedPreviewBar(player) {
  const previewEl = $("selectedPreviewBar");
  if (!selectedCardId) {
    previewEl.classList.add("hidden");
    refreshMoveSelectorLabels(null);
    return;
  }
  const card = player.roster.find((c) => c.card_id === selectedCardId);
  if (!card) return;
  const tier = getCardTier(card);
  const styleLabel = selectedStyle.toUpperCase();
  const atkHtml = formatStatSignal(card[`${selectedStyle}_atk`], tier, `${selectedStyle}_atk`);
  const defHtml = formatStatSignal(card[`${selectedStyle}_def`], tier, `${selectedStyle}_def`);
  const statHtml = formatStatSignal(card[selectedBasicStat], tier, selectedBasicStat);

  updateFiveRoundStatButtons(player);
  refreshMoveSelectorLabels(card);

  previewEl.classList.remove("hidden");
  previewEl.innerHTML = `
    <img src="${getPortraitSrc(card)}" alt="${card.character_version}" />
    <div>
      <div><strong class="gold-text">Marked Card:</strong> ${card.character_version} (${card.card_id})</div>
      <div class="muted">Active Pick: <b>${styleLabel}</b> (ATK ${atkHtml} / DEF ${defHtml}) + <b>${selectedBasicStat.toUpperCase()}</b> (${statHtml})</div>
    </div>
  `;
}

function revealActiveHand() {
  const activeTier = getActiveProgressionTier(matchState);
  const side = mySide();
  const player = matchState.players[side];

  $("turnCurtain").classList.add("hidden");
  $("turnControls").classList.remove("hidden");

  selectedCardId = null;
  $("selectedPreviewBar").classList.add("hidden");
  refreshMoveSelectorLabels(null);
  $("btnLockMove").disabled = true;
  $("btnLockMove").textContent = "Select a Card Above to Lock Move";
  syncStyleButtonsForPlayer(player);

  updateFiveRoundStatButtons(player);
  $("activeTierPrompt").textContent = `${player.name} — Tap 1 available Tier ${activeTier} card: (${getFiveRoundStatProgress(player).distinctCount}/3 basic stats in Rounds ${getFiveRoundStatProgress(player).blockStartTurn}–${getFiveRoundStatProgress(player).blockEndTurn})`;

  const tierCards = player.roster.filter((c) => getCardTier(c) === activeTier);
  $("handGrid").innerHTML = tierCards
    .map((c) => {
      const isUsed = player.usedCardIds.includes(c.card_id);
      const isCap = c.card_id === player.captainId;
      const isVc = c.card_id === player.viceCaptainId;

      let badges = "";
      if (isCap) badges += '<span class="badge badge-cap">CAP 2×</span>';
      if (isVc) badges += '<span class="badge badge-vc">VC 1.5×</span>';
      if (isUsed) badges += '<span class="badge badge-used">USED</span>';

      const classes = [
        isCap ? "cap-card" : isVc ? "vc-card" : "",
        isUsed ? "used" : "",
      ]
        .filter(Boolean)
        .join(" ");

      return renderCardMarkup(c, { badgeHtml: badges, extraClass: classes, selectedRibbon: false });
    })
    .join("");

  $("handGrid").querySelectorAll(".game-card").forEach((el) => {
    el.onclick = () => {
      const cid = el.dataset.id;
      if (player.usedCardIds.includes(cid)) return;
      selectedCardId = cid;

      $("btnLockMove").disabled = false;
      if (isOnline()) {
        $("btnLockMove").textContent = "Lock My Move Privately & Wait for Opponent";
      } else {
        $("btnLockMove").textContent =
          pickStep === "P1_PICK"
            ? `Lock ${player.name}'s Move & Pass to ${matchState.players.B.name}`
            : `Lock ${player.name}'s Move & Simulate Clash!`;
      }

      $("handGrid").querySelectorAll(".game-card").forEach((cardEl) => {
        const isThis = cardEl.dataset.id === selectedCardId;
        cardEl.classList.toggle("selected", isThis);
        const existingRibbon = cardEl.querySelector(".selected-ribbon");
        if (isThis && !existingRibbon) {
          cardEl.insertAdjacentHTML("afterbegin", '<div class="selected-ribbon">✓ SELECTED</div>');
        } else if (!isThis && existingRibbon) {
          existingRibbon.remove();
        }
      });

      updateSelectedPreviewBar(player);
    };
  });
}

function resolveOnlineTurnOnHost() {
  if (!lockedMoveA || !remoteMoveBuffer) return;
  let record;
  try {
    record = executeSimultaneousClash(matchState, {
      moveA: lockedMoveA,
      moveB: remoteMoveBuffer,
    });
  } catch (err) {
    console.error("[Host] Illegal move rejected:", err);
    lockedMoveA = null;
    remoteMoveBuffer = null;
    myMoveLockedOnline = false;
    roomClient.send({ type: "MOVE_REJECTED", reason: err.message });
    $("turnCurtainSub").textContent = `Move rejected: ${err.message}`;
    prepareOnlineTurnUi();
    return;
  }

  const stateSnapshot = {
    turn: matchState.turn,
    activeTier: matchState.activeTier,
    status: matchState.status,
    winner: matchState.winner,
    players: {
      A: {
        hp: matchState.players.A.hp,
        extraArmorHp: matchState.players.A.extraArmorHp,
        shields: matchState.players.A.shields,
        usedCardIds: [...matchState.players.A.usedCardIds],
        basicStatHistory: [...matchState.players.A.basicStatHistory],
      },
      B: {
        hp: matchState.players.B.hp,
        extraArmorHp: matchState.players.B.extraArmorHp,
        shields: matchState.players.B.shields,
        usedCardIds: [...matchState.players.B.usedCardIds],
        basicStatHistory: [...matchState.players.B.basicStatHistory],
      },
    },
  };

  roomClient.send({
    type: "HOST_TURN_RESOLVED",
    record,
    stateAfter: stateSnapshot,
  });
  persistOnlineState();

  lockedMoveA = null;
  remoteMoveBuffer = null;
  myMoveLockedOnline = false;
  pickStep = "CLASH_REVEAL";
  runAnimatedBattleSimulation(record);
}

// ============================================================================
// BASIC STAT ACTIVATION REPORT + VISUAL CALCULATION CARDS
// ============================================================================
function buildBasicStatReportCard(playerName, cardName, chosenStat, statusObj) {
  const statUpper = chosenStat.toUpperCase();
  const isActivated = Boolean(statusObj?.activated);
  const layer = statusObj?.layer || "NONE";

  const stateClass = !isActivated
    ? "state-missed"
    : layer === "ELITE"
    ? "state-elite"
    : layer === "CHIP"
    ? "state-entry"
    : "state-entry";

  const pillClass = !isActivated
    ? "status-pill-missed"
    : layer === "ELITE"
    ? "status-pill-elite"
    : layer === "CHIP"
    ? "status-pill-entry"
    : "status-pill-entry";

  const pillText = !isActivated
    ? "✕ NOT ACTIVATED"
    : layer === "ELITE"
    ? "★ ACTIVATED · ELITE"
    : layer === "CHIP"
    ? "✓ ACTIVATED · CHIP"
    : "✓ ACTIVATED · ENTRY";

  const bonusCls = !isActivated ? "missed" : layer === "ELITE" ? "elite" : "entry";
  const labelText = statusObj?.label ? `${statusObj.label} — ` : "";
  const bonusText = statusObj?.bonusText || "No Bonus";
  const reasonText = statusObj?.reason || "";

  return `
    <div class="stat-report-card ${stateClass}">
      <div class="stat-report-top">
        <strong>${playerName} · Chose <span class="gold-text">${statUpper}</span></strong>
        <span class="status-pill ${pillClass}">${pillText}</span>
      </div>
      <div class="stat-report-bonus ${bonusCls}">${labelText}${bonusText}</div>
      <div class="stat-report-reason">${cardName}${reasonText ? ` · ${reasonText}` : ""}</div>
    </div>
  `;
}

function buildCalcCardHtml({ attackerName, defenderName, style, clashRes, finalDmg, roleBonus, shieldGain }) {
  const isHit = finalDmg > 0;
  const branchClass = isHit ? "branch-hit" : "branch-block";
  const branchText = isHit ? "HIT · " + clashRes.branch.replace("_", " ") : "BLOCKED · GUARD HOLDS";

  const chips = [];
  chips.push(`<span class="calc-chip">Style: ${style.toUpperCase()}</span>`);

  const atkSt = clashRes.atkStatStatus;
  if (atkSt && atkSt.stat !== "none") {
    if (atkSt.activated) {
      const cls = atkSt.layer === "ELITE" ? "mod-elite" : "mod-active";
      chips.push(`<span class="calc-chip ${cls}">✓ ${atkSt.stat.toUpperCase()}: ${atkSt.bonusText}</span>`);
    } else {
      chips.push(`<span class="calc-chip mod-missed">✕ ${atkSt.stat.toUpperCase()}: ${atkSt.label}</span>`);
    }
  }

  const defSt = clashRes.defStatStatus;
  if (defSt && defSt.stat !== "none") {
    if (defSt.activated) {
      const cls = defSt.layer === "ELITE" ? "mod-elite" : "mod-active";
      chips.push(`<span class="calc-chip ${cls}">✓ ${defSt.stat.toUpperCase()}: ${defSt.bonusText}</span>`);
    } else {
      chips.push(`<span class="calc-chip mod-missed">✕ ${defSt.stat.toUpperCase()}: ${defSt.label}</span>`);
    }
  }

  if (roleBonus !== "NONE") {
    chips.push(`<span class="calc-chip mod-leader">${roleBonus.replace("_", " ")}</span>`);
  }

  const stepsHtml = clashRes.breakdown
    .slice(1, -1)
    .map((line) => `<li>${line}</li>`)
    .join("");

  return `
    <div class="calc-card">
      <div class="calc-card-header">
        <strong>${attackerName} → ${defenderName}</strong>
        <span class="branch-tag ${branchClass}">${branchText}</span>
      </div>
      <div class="calc-vs-row">
        <span>ATK (${style.toUpperCase()}): <strong class="gold-text">${clashRes.atk}</strong></span>
        <span class="muted">vs</span>
        <span>DEF (${style.toUpperCase()}): <strong class="blue-text">${clashRes.def}</strong></span>
      </div>
      <div class="calc-chips">${chips.join("")}</div>
      <details>
        <summary class="muted" style="cursor:pointer">View Math Steps</summary>
        <ul class="calc-steps">${stepsHtml}</ul>
      </details>
      <div class="calc-outcome">
        <span>Damage: <span class="${isHit ? "red-text" : "ok"}">${finalDmg} HP</span></span>
        <span>${defenderName} Shield: <span class="blue-text">+${shieldGain.shieldEarned.toFixed(1)}</span></span>
      </div>
    </div>
  `;
}

// ============================================================================
// SEQUENTIAL ANIME VFX BATTLE SIMULATION
// ============================================================================
function runAnimatedBattleSimulation(record) {
  clearAnimTimers();
  lastClashRecord = record;

  const pA = matchState.players.A;
  const pB = matchState.players.B;
  const cardA = pA.roster.find((c) => c.card_id === record.moveA.cardId);
  const cardB = pB.roster.find((c) => c.card_id === record.moveB.cardId);

  const badgeA = `<span class="badge badge-cap">${pA.name}: ${record.moveA.style.toUpperCase()} + ${record.moveA.basicStat.toUpperCase()}</span>`;
  const badgeB = `<span class="badge badge-vc">${pB.name}: ${record.moveB.style.toUpperCase()} + ${record.moveB.basicStat.toUpperCase()}</span>`;

  $("turnControls").classList.add("hidden");
  $("turnCurtain").classList.add("hidden");
  $("clashRevealPanel").classList.remove("hidden");
  $("revealDetailsWrapper").classList.add("hidden");
  $("btnReplayAnim").classList.add("hidden");
  $("revealHeadline").textContent = `Turn ${record.turn} (${record.tier}) — Live Anime Battle Sequence`;

  const vfxBadge = $("stageVfxBadge");
  const arrowEl = $("stageArrow");
  const statusEl = $("stageStatusBanner");

  $("stageFighterA").innerHTML = renderCardMarkup(cardA, { badgeHtml: badgeA, extraClass: "anim-enter-left" });
  $("stageFighterB").innerHTML = renderCardMarkup(cardB, { badgeHtml: badgeB, extraClass: "anim-enter-right" });
  vfxBadge.className = "vfx-badge";
  vfxBadge.textContent = "FACE OFF!";
  arrowEl.textContent = "⚔️";
  statusEl.textContent = `${pA.name} vs ${pB.name}`;
  fxEngine.playClashIntro();

  animTimers.push(setTimeout(() => {
    $("stageFighterA").innerHTML = renderCardMarkup(cardA, { badgeHtml: badgeA, extraClass: "anim-lunge-right" });
    $("stageFighterB").innerHTML = renderCardMarkup(cardB, { badgeHtml: badgeB });
    vfxBadge.className = `vfx-badge vfx-${record.moveA.style}`;
    vfxBadge.textContent = `${pA.name} ${record.moveA.style.toUpperCase()}!`;
    arrowEl.textContent = "➔";
    statusEl.textContent = `${pA.name} unleashes ${record.moveA.style.toUpperCase()}!`;
    fxEngine.playStyleAttack("A", record.moveA.style);
  }, 680));

  animTimers.push(setTimeout(() => {
    const p1Hit = record.outgoingDamageAtoB > 0;
    const p1Heavy = record.outgoingDamageAtoB >= 14 || record.roleBonusA !== "NONE";
    const popupB = p1Hit
      ? `<div class="floating-popup popup-dmg">HIT! -${record.outgoingDamageAtoB} HP</div>`
      : `<div class="floating-popup popup-block">BLOCKED! +${record.shieldGainB.shieldEarned.toFixed(1)} SH</div>`;
    const popupCounterA =
      record.counterToA > 0
        ? `<div class="floating-popup popup-counter">COUNTER! -${record.counterToA} HP</div>`
        : "";

    $("stageFighterA").innerHTML = renderCardMarkup(cardA, {
      badgeHtml: badgeA,
      extraClass: record.counterToA > 0 ? "anim-hit" : "",
      popupHtml: popupCounterA,
    });
    $("stageFighterB").innerHTML = renderCardMarkup(cardB, {
      badgeHtml: badgeB,
      extraClass: p1Hit ? "anim-hit" : "anim-block",
      popupHtml: popupB,
    });
    statusEl.textContent = p1Hit
      ? `${pA.name} LANDS ${record.outgoingDamageAtoB} DMG!`
      : `${pB.name} BLOCKED! (+${record.shieldGainB.shieldEarned.toFixed(1)} Shield)`;

    fxEngine.playImpact("B", {
      isHit: p1Hit,
      heavy: p1Heavy,
      style: record.moveA.style,
      isCounter: record.counterToA > 0,
    });
  }, 1140));

  animTimers.push(setTimeout(() => {
    $("stageFighterA").innerHTML = renderCardMarkup(cardA, { badgeHtml: badgeA });
    $("stageFighterB").innerHTML = renderCardMarkup(cardB, { badgeHtml: badgeB, extraClass: "anim-lunge-left" });
    vfxBadge.className = `vfx-badge vfx-${record.moveB.style}`;
    vfxBadge.textContent = `${pB.name} ${record.moveB.style.toUpperCase()}!`;
    arrowEl.textContent = "⬅";
    statusEl.textContent = `${pB.name} counters with ${record.moveB.style.toUpperCase()}!`;
    fxEngine.playStyleAttack("B", record.moveB.style);
  }, 2050));

  animTimers.push(setTimeout(() => {
    const p2Hit = record.outgoingDamageBtoA > 0;
    const p2Heavy = record.outgoingDamageBtoA >= 14 || record.roleBonusB !== "NONE";
    const popupA = p2Hit
      ? `<div class="floating-popup popup-dmg">HIT! -${record.outgoingDamageBtoA} HP</div>`
      : `<div class="floating-popup popup-block">BLOCKED! +${record.shieldGainA.shieldEarned.toFixed(1)} SH</div>`;
    const popupCounterB =
      record.counterToB > 0
        ? `<div class="floating-popup popup-counter">COUNTER! -${record.counterToB} HP</div>`
        : "";

    $("stageFighterA").innerHTML = renderCardMarkup(cardA, {
      badgeHtml: badgeA,
      extraClass: p2Hit ? "anim-hit" : "anim-block",
      popupHtml: popupA,
    });
    $("stageFighterB").innerHTML = renderCardMarkup(cardB, {
      badgeHtml: badgeB,
      extraClass: record.counterToB > 0 ? "anim-hit" : "",
      popupHtml: popupCounterB,
    });
    statusEl.textContent = p2Hit
      ? `${pB.name} LANDS ${record.outgoingDamageBtoA} DMG!`
      : `${pA.name} BLOCKED! (+${record.shieldGainA.shieldEarned.toFixed(1)} Shield)`;

    fxEngine.playImpact("A", {
      isHit: p2Hit,
      heavy: p2Heavy,
      style: record.moveB.style,
      isCounter: record.counterToB > 0,
    });

    updateHud();
    renderHistoryLog();
  }, 2510));

  animTimers.push(setTimeout(() => {
    vfxBadge.className = "vfx-badge";
    vfxBadge.textContent = "CLASH RESOLVED";
    arrowEl.textContent = "✓";
    $("btnReplayAnim").classList.remove("hidden");
    $("revealDetailsWrapper").classList.remove("hidden");

    const statA = record.moveA.basicStat;
    const statusA =
      statA === "spd" || statA === "acc"
        ? record.simResult.attackAtoB.atkStatStatus
        : record.simResult.attackBtoA.defStatStatus;

    const statB = record.moveB.basicStat;
    const statusB =
      statB === "spd" || statB === "acc"
        ? record.simResult.attackBtoA.atkStatStatus
        : record.simResult.attackAtoB.defStatStatus;

    $("basicStatReportGrid").innerHTML =
      buildBasicStatReportCard(pA.name, cardA.character_version, statA, statusA) +
      buildBasicStatReportCard(pB.name, cardB.character_version, statB, statusB);

    $("calcCardsGrid").innerHTML =
      buildCalcCardHtml({
        attackerName: pA.name,
        defenderName: pB.name,
        style: record.moveA.style,
        clashRes: record.simResult.attackAtoB,
        finalDmg: record.outgoingDamageAtoB,
        roleBonus: record.roleBonusA,
        shieldGain: record.shieldGainB,
      }) +
      buildCalcCardHtml({
        attackerName: pB.name,
        defenderName: pA.name,
        style: record.moveB.style,
        clashRes: record.simResult.attackBtoA,
        finalDmg: record.outgoingDamageBtoA,
        roleBonus: record.roleBonusB,
        shieldGain: record.shieldGainA,
      });

    $("revealNetSummary").innerHTML = `
      <div>${pA.name} Net Taken: <span class="red-text">-${record.totalDamageToA} HP</span> | Shield: <span class="ok">+${record.shieldGainA.shieldEarned.toFixed(1)}</span></div>
      <div>${pB.name} Net Taken: <span class="red-text">-${record.totalDamageToB} HP</span> | Shield: <span class="ok">+${record.shieldGainB.shieldEarned.toFixed(1)}</span></div>
    `;

    $("btnNextTurn").textContent =
      matchState.status === "FINISHED"
        ? "View Final Match Result"
        : `Continue to Turn ${matchState.turn} (Tier ${matchState.activeTier})`;
  }, 3200));
}

function handleLockMove() {
  if (!selectedCardId) return;
  const curPlayer = matchState?.players?.[mySide()];
  const styleCheck = evaluateCombatStyleChoice(curPlayer, selectedStyle);
  if (!styleCheck.allowed) {
    alert(styleCheck.reason);
    syncStyleButtonsForPlayer(curPlayer);
    return;
  }

  const chosenMove = {
    cardId: selectedCardId,
    style: selectedStyle,
    basicStat: selectedBasicStat,
  };

  if (isOnline()) {
    myMoveLockedOnline = true;
    $("turnControls").classList.add("hidden");
    $("turnCurtain").classList.remove("hidden");
    $("btnRevealTurn").classList.add("hidden");
    $("turnCurtainTitle").textContent = "Move Locked Privately!";
    updateHud();

    if (roomClient.role === "HOST") {
      lockedMoveA = chosenMove;
      if (remoteMoveBuffer) {
        resolveOnlineTurnOnHost();
      } else {
        $("turnCurtainSub").textContent = "Waiting for Player 2 to lock their move in the room...";
      }
    } else {
      roomClient.send({ type: "GUEST_MOVE_LOCKED", move: chosenMove, turn: matchState.turn });
      $("turnCurtainSub").textContent = "Sent to Host! Waiting for simultaneous clash resolution...";
    }
    return;
  }

  if (isVsComputer()) {
    const aiMove = chooseComputerMove(matchState, "B", aiDifficulty, tierAverages);
    const record = executeSimultaneousClash(matchState, {
      moveA: chosenMove,
      moveB: aiMove,
    });
    pickStep = "CLASH_REVEAL";
    runAnimatedBattleSimulation(record);
    return;
  }

  if (pickStep === "P1_PICK") {
    lockedMoveA = chosenMove;
    pickStep = "P2_PICK";
    prepareTurnCurtain();
    return;
  }

  const record = executeSimultaneousClash(matchState, {
    moveA: lockedMoveA,
    moveB: chosenMove,
  });

  pickStep = "CLASH_REVEAL";
  runAnimatedBattleSimulation(record);
}

function advanceTurn() {
  clearAnimTimers();
  if (matchState.status === "FINISHED") {
    $("clashRevealPanel").classList.add("hidden");
    $("matchOverPanel").classList.remove("hidden");
    const w = matchState.winner;
    $("winnerTitle").textContent =
      w === "DRAW" ? "Match Ended in a Draw!" : `${matchState.players[w].name} Wins the Match!`;
    const pA = matchState.players.A;
    const pB = matchState.players.B;
    $("winnerSummary").textContent =
      `${pA.name}: ${pA.hp} HP (+${pA.extraArmorHp} Armor) | ${pB.name}: ${pB.hp} HP (+${pB.extraArmorHp} Armor)`;
    return;
  }

  pickStep = "P1_PICK";
  lockedMoveA = null;
  if (!isOnline()) remoteMoveBuffer = null; // online: guest may already have locked the next move
  myMoveLockedOnline = false;
  selectedCardId = null;
  prepareTurnCurtain();
}

function renderHistoryLog() {
  if (!matchState) return;
  $("historyLog").innerHTML = matchState.history
    .slice()
    .reverse()
    .map((item) => {
      if (item.type === "SHIELD_ACTIVATED") {
        const p = matchState.players[item.playerSide];
        return `<div class="history-item"><b>[Turn ${item.turn}]</b> ${p.name} used 3.0 Shields (${item.mode}: +${item.amountApplied} HP)</div>`;
      }
      const pA = matchState.players.A;
      const pB = matchState.players.B;
      return `<div class="history-item"><b>[Turn ${item.turn} · ${item.tier}]</b> ${pA.name} (${item.moveA.cardId} ${item.moveA.style.toUpperCase()}/${item.moveA.basicStat.toUpperCase()}) vs ${pB.name} (${item.moveB.cardId} ${item.moveB.style.toUpperCase()}/${item.moveB.basicStat.toUpperCase()}) → ${pA.name} took ${item.totalDamageToA} HP (+${item.shieldGainA.shieldEarned.toFixed(1)} SH), ${pB.name} took ${item.totalDamageToB} HP (+${item.shieldGainB.shieldEarned.toFixed(1)} SH)</div>`;
    })
    .join("");
}

// ============================================================================

let activeRulesTier = "L1";

function renderRulesModal(tierKey = activeRulesTier) {
  activeRulesTier = TIERS.includes(tierKey) ? tierKey : "L1";
  const cfg = TIER_RULES_CONFIG;
  const isHi = cfg.HIGH_TIERS.includes(activeRulesTier);

  const spdOff = cfg.SPD_ENTRY_OFFSET[activeRulesTier];
  const spdTh = cfg.SPD_ELITE_THRESHOLDS[activeRulesTier];
  const spdGlance = isHi ? cfg.SPD_GLANCE_BONUS.high : cfg.SPD_GLANCE_BONUS.low;

  const accK = cfg.ACC_ENTRY_LEAD[activeRulesTier];
  const accEliteLead = accK + cfg.ACC_ELITE_EXTRA_LEAD;
  const accFloor = cfg.ACC_ELITE_FLOOR[activeRulesTier];
  const accEntryDmg = isHi ? cfg.ACC_ENTRY_BONUS.high : cfg.ACC_ENTRY_BONUS.low;
  const accEliteDmg = isHi ? cfg.ACC_ELITE_BONUS.high : cfg.ACC_ELITE_BONUS.low;

  const durOff = cfg.DUR_ENTRY_OFFSET[activeRulesTier];
  const durEl = cfg.DUR_ELITE_RULES[activeRulesTier];

  const adpLead = cfg.ADP_ENTRY_LEAD[activeRulesTier];
  const adpEl = cfg.ADP_ELITE_RULES[activeRulesTier];
  const adpCounter = isHi ? cfg.ADP_ENTRY_COUNTER.high : cfg.ADP_ENTRY_COUNTER.low;

  $("rulesTierTabs").querySelectorAll("button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.rtier === activeRulesTier);
  });

  $("rulesTierBody").innerHTML = `
    <div class="rule-box">
      <h4>⚡ SPD — Guard Hold Offense <span class="rule-badge-branch">DEF ≥ ATK</span></h4>
      <div class="rule-line"><b>Genjutsu Gate:</b> GEN style only opens if <code>GEN_ATK ≥ 0.90 × GEN_DEF</code>.</div>
      <div class="rule-line"><b>Entry (Glance):</b> <code>SPD_A ≥ SPD_D - ${spdOff}</code> → <b>+${spdGlance} HP</b> chip.</div>
      <div class="rule-line"><b>Elite Openings (Lead &amp; Floor):</b> Flank <code>+${spdTh.FLANK[0]} / ${spdTh.FLANK[1]}× DEF</code> · Blindspot <code>+${spdTh.BLINDSPOT[0]} / ${spdTh.BLINDSPOT[1]}× DEF</code> · Blitz <code>+${spdTh.BLITZ[0]} / ${spdTh.BLITZ[1]}× DEF</code>.</div>
    </div>

    <div class="rule-box">
      <h4>🎯 ACC — Breakthrough Offense <span class="rule-badge-branch">ATK &gt; DEF</span></h4>
      <div class="rule-line"><b>Chip (Close Precision):</b> <code>ACC_D + ${accK} ≥ ACC_A ≥ ACC_D</code> → <b>+${cfg.ACC_CHIP_BONUS} HP</b> chip DMG across all tiers.</div>
      <div class="rule-line"><b>Entry (Precision Hit):</b> <code>ACC_A ≥ ACC_D + ${accK}</code> → <b>+${accEntryDmg} HP</b> bonus DMG.</div>
      <div class="rule-line"><b>Elite (Critical Weak-Point):</b> <code>ACC_A ≥ ACC_D + ${accEliteLead}</code>, <code>ACC_A ≥ ${accFloor}× DEF</code> &amp; <code>ATK - DEF ≥ 2</code> → <b>+${accEliteDmg} HP</b> bonus DMG.</div>
    </div>

    <div class="rule-box">
      <h4>🛡️ DUR — Breakthrough Defense <span class="rule-badge-branch">ATK &gt; DEF · MAX ${cfg.DUR_MAX_CAP_PCT}% CAP</span></h4>
      <div class="rule-line"><b>Entry (Light Brace):</b> <code>DUR_D ≥ DUR_A - ${durOff}</code> → <b>-15%</b> DMG (min -1 HP, capped at <b>-2 HP</b> saved).</div>
      <div class="rule-line"><b>Elite (Heavy Tank — Capped ${cfg.DUR_MAX_CAP_PCT}%):</b> <code>DUR_D - DUR_A ≥ +${durEl.lead}</code> AND <code>DUR_D ≥ ${durEl.floor}× ATK</code> → <b>-20%</b> (≤4 DMG) or <b>-${cfg.DUR_MAX_CAP_PCT}% max</b> (&gt;4 DMG), min 1 HP.</div>
    </div>

    <div class="rule-box">
      <h4>🔁 5-Round Matchup Stat Rule <span class="rule-badge-branch">MIN ${FIVE_ROUND_MIN_DISTINCT_STATS} BASIC STATS</span></h4>
      <div class="rule-line"><b>Rule:</b> In every 5-round block (Rounds 1–5, 6–10, etc.), one basic stat can be used <b>at most ${FIVE_ROUND_MAX_SAME_STAT} times</b>, and you must use at least <b>${FIVE_ROUND_MIN_DISTINCT_STATS} distinct basic stats</b> (if one stat is used ${FIVE_ROUND_MAX_SAME_STAT}×, explore at least <b>2 other stats</b>).</div>
      <div class="rule-line"><b>Round 5 Check:</b> If you still have fewer than ${FIVE_ROUND_MIN_DISTINCT_STATS} distinct stats by Round 5 of a block, your Round 5 pick must introduce a new basic stat.</div>
    </div>

    <div class="rule-box">
      <h4>🌀 ADP — Guard Hold Defense <span class="rule-badge-branch">DEF &gt; ATK</span></h4>
      <div class="rule-line"><b>Entry (Tactical Read):</b> Strict <code>DEF &gt; ATK</code>, incoming SPD damage <code>&gt; 0</code> &amp; <code>ADP_D ≥ ADP_A + ${adpLead}</code> → <b>-20%</b> SPD opening cut + <b>+${adpCounter} HP</b> counter.</div>
      <div class="rule-line"><b>Elite (Flank / Blindspot / Blitz):</b> Strict <code>DEF &gt; ATK</code> &amp; <code>ADP_D ≥ max(ADP_A + ${adpEl.lead}, ${adpEl.floor}× B)</code> where <code>B = ⌈(ATK + DEF)/2⌉</code>.</div>
    </div>
  `;
}

// WIRE BUTTONS & CHOICE GROUPS
// ============================================================================
$("modeBtnGroup").querySelectorAll("button").forEach((btn) => {
  btn.onclick = () => {
    $("modeBtnGroup").querySelectorAll("button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    playMode = btn.dataset.mode;
    $("onlineRoomPanel").classList.toggle("hidden", !isOnline());
    $("aiSettingsPanel").classList.toggle("hidden", !isVsComputer());
    updateRoomHeaderBadge();
  };
});

$("aiDiffBtnGroup").querySelectorAll("button").forEach((btn) => {
  btn.onclick = () => {
    $("aiDiffBtnGroup").querySelectorAll("button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    aiDifficulty = btn.dataset.aidiff;
  };
});

$("btnCreateRoom").onclick = handleCreateRoom;
$("btnJoinRoom").onclick = handleJoinRoom;

$("presetSelect").onchange = renderPresetSummary;
$("btnDraftTeams").onclick = startDraft;
$("btnRevealLeaders").onclick = () => {
  $("btnRevealLeaders").classList.remove("hidden");
  $("leaderCurtain").classList.add("hidden");
  $("leaderPickerContent").classList.remove("hidden");
  renderLeaderPicker();
};
$("btnConfirmLeaders").onclick = confirmLeaders;
$("btnRevealTurn").onclick = revealActiveHand;
$("btnLockMove").onclick = handleLockMove;
$("btnNextTurn").onclick = advanceTurn;
$("btnReplayAnim").onclick = () => lastClashRecord && runAnimatedBattleSimulation(lastClashRecord);
$("btnShieldA").onclick = () => handleActivateShield("A");
$("btnShieldB").onclick = () => handleActivateShield("B");
$("btnRestartTop").onclick = () => showScreen("screenSetup");
$("btnPlayAgain").onclick = () => showScreen("screenSetup");
$("btnToggleSfx").onclick = () => {
  sfxEnabled = !sfxEnabled;
  fxEngine.setSoundEnabled(sfxEnabled);
  $("btnToggleSfx").textContent = sfxEnabled ? "🔊 SFX: ON" : "🔇 SFX: OFF";
};

$("styleBtnGroup").querySelectorAll("button").forEach((btn) => {
  btn.onclick = () => {
    $("styleBtnGroup").querySelectorAll("button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    if (btn.disabled) return;
    selectedStyle = btn.dataset.style;
    if (matchState) updateSelectedPreviewBar(matchState.players[mySide()]);
  };
});

$("basicStatBtnGroup").querySelectorAll("button").forEach((btn) => {
  btn.onclick = () => {
    $("basicStatBtnGroup").querySelectorAll("button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    selectedBasicStat = btn.dataset.stat;
    if (matchState) updateSelectedPreviewBar(matchState.players[mySide()]);
  };
});


$("btnOpenRules").onclick = () => {
  const currentTier = (matchState && getActiveProgressionTier(matchState)) || activeRulesTier || "L1";
  renderRulesModal(currentTier);
  $("rulesModal").classList.remove("hidden");
};
$("btnCloseRules").onclick = () => $("rulesModal").classList.add("hidden");
$("rulesModal").onclick = (e) => {
  if (e.target === $("rulesModal")) $("rulesModal").classList.add("hidden");
};
$("rulesTierTabs").querySelectorAll("button").forEach((btn) => {
  btn.onclick = () => renderRulesModal(btn.dataset.rtier);
});

renderPresetSummary();
initDatabase();
