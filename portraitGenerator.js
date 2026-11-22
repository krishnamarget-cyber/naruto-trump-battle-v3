// portraitGenerator.js — Offline Anime-Style Character Portrait Renderer (with optional ./portraits/<card_id>.png fallback)

function hashStr(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function getCharacterVisualTheme(card) {
  const name = card.character_version.toLowerCase();
  const tier = card.card_id.split("-")[0];

  if (name.includes("itachi") || name.includes("sasuke") || name.includes("madara") || name.includes("obito") || name.includes("shisui") || name.includes("indra")) {
    return {
      bg1: "#2a0812", bg2: "#7f1d1d", accent: "#ef4444", hair: "#0f172a", skin: "#f1c6a7",
      eye: name.includes("rinnegan") || name.includes("madara") || name.includes("obito") ? "#c084fc" : "#ef4444",
      emblem: "SHARINGAN",
    };
  }
  if (name.includes("naruto") || name.includes("minato") || name.includes("kushina") || name.includes("asura")) {
    return {
      bg1: "#3b1d06", bg2: "#d97706", accent: "#fbbf24", hair: "#facc15", skin: "#f3c6a5",
      eye: name.includes("sage") || name.includes("six paths") ? "#f59e0b" : "#38bdf8",
      emblem: "UZUMAKI",
    };
  }
  if (name.includes("kakashi") || name.includes("sakumo") || name.includes("tobirama") || name.includes("jiraiya")) {
    return {
      bg1: "#0f172a", bg2: "#1e3a8a", accent: "#60a5fa", hair: "#e2e8f0", skin: "#f1c6a7",
      eye: name.includes("kakashi") ? "#ef4444" : "#38bdf8",
      emblem: "LEAF_ELITE",
    };
  }
  if (name.includes("sakura") || name.includes("tsunade") || name.includes("kurenai") || name.includes("tayuya") || name.includes("karui")) {
    return {
      bg1: "#3b0722", bg2: "#be185d", accent: "#f472b6", hair: name.includes("tsunade") ? "#fde047" : "#f472b6", skin: "#f5ccb0",
      eye: "#34d399",
      emblem: "MEDICAL",
    };
  }
  if (name.includes("neji") || name.includes("hinata") || name.includes("hiashi") || name.includes("hanabi") || name.includes("hamura") || name.includes("toneri")) {
    return {
      bg1: "#1e1b4b", bg2: "#4338ca", accent: "#a5b4fc", hair: "#1e1b4b", skin: "#f5d0b5",
      eye: "#e0e7ff",
      emblem: "BYAKUGAN",
    };
  }
  if (name.includes("guy") || name.includes("rock lee")) {
    return {
      bg1: "#052e16", bg2: "#15803d", accent: "#4ade80", hair: "#090d16", skin: "#eab696",
      eye: name.includes("gate") ? "#f8fafc" : "#1e293b",
      emblem: "YOUTH",
    };
  }
  if (name.includes("gaara") || name.includes("temari") || name.includes("kankuro") || name.includes("rasa") || name.includes("chiyo") || name.includes("baki")) {
    return {
      bg1: "#451a03", bg2: "#92400e", accent: "#f59e0b", hair: name.includes("gaara") || name.includes("rasa") ? "#b91c1c" : "#fde68a", skin: "#f1c6a7",
      eye: "#2dd4bf",
      emblem: "SAND",
    };
  }
  if (name.includes("kaguya") || name.includes("hagoromo") || name.includes("momoshiki") || name.includes("kinshiki")) {
    return {
      bg1: "#1e1b4b", bg2: "#581c87", accent: "#e879f9", hair: "#f8fafc", skin: "#f8fafc",
      eye: "#d8b4fe",
      emblem: "OTSUKSUKI",
    };
  }
  if (name.includes("kisame") || name.includes("zabuza") || name.includes("haku") || name.includes("suigetsu") || name.includes("mei") || name.includes("chojuro") || name.includes("yagura") || name.includes("gengetsu")) {
    return {
      bg1: "#082f49", bg2: "#0369a1", accent: "#38bdf8", hair: "#1e293b", skin: "#cbd5e1",
      eye: "#38bdf8",
      emblem: "MIST",
    };
  }

  const h = hashStr(card.card_id);
  const palettes = [
    { bg1: "#172554", bg2: "#1d4ed8", accent: "#60a5fa", hair: "#1e293b", skin: "#f1c6a7", eye: "#38bdf8", emblem: tier },
    { bg1: "#14532d", bg2: "#15803d", accent: "#4ade80", hair: "#27272a", skin: "#eab696", eye: "#a3e635", emblem: tier },
    { bg1: "#312e81", bg2: "#4f46e5", accent: "#818cf8", hair: "#0f172a", skin: "#f1c6a7", eye: "#c084fc", emblem: tier },
  ];
  return palettes[h % palettes.length];
}

export function buildCardPortraitDataUrl(card) {
  const th = getCharacterVisualTheme(card);
  const initials = card.character_version
    .split(/[\s—-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
  const tier = card.card_id.split("-")[0];
  const isUchiha = th.emblem === "SHARINGAN";
  const isUzumaki = th.emblem === "UZUMAKI";
  const isByakugan = th.emblem === "BYAKUGAN";
  const isOtsutsuki = th.emblem === "OTSUKSUKI";

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${th.bg1}"/>
        <stop offset="100%" stop-color="${th.bg2}"/>
      </linearGradient>
      <radialGradient id="aura" cx="50%" cy="45%" r="50%">
        <stop offset="0%" stop-color="${th.accent}" stop-opacity="0.45"/>
        <stop offset="100%" stop-color="${th.accent}" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="120" height="120" rx="14" fill="url(#bg)"/>
    <circle cx="60" cy="54" r="48" fill="url(#aura)"/>
    ${isOtsutsuki ? `<polygon points="36,34 42,14 48,36" fill="#e2e8f0"/><polygon points="84,34 78,14 72,36" fill="#e2e8f0"/>` : ""}
    <!-- Shoulders / Shinobi Cloak -->
    <path d="M22,118 C24,90 40,84 60,84 C80,84 96,90 98,118 Z" fill="#0f172a" stroke="${th.accent}" stroke-width="2"/>
    <path d="M46,85 L60,104 L74,85" fill="none" stroke="${th.accent}" stroke-width="2.5"/>
    <!-- Neck & Face -->
    <rect x="52" y="70" width="16" height="18" rx="6" fill="${th.skin}"/>
    <path d="M38,48 C38,30 82,30 82,48 C82,69 71,78 60,78 C49,78 38,69 38,48 Z" fill="${th.skin}"/>
    <!-- Headband -->
    <rect x="37" y="38" width="46" height="10" rx="3" fill="#1e293b"/>
    <rect x="47" y="39" width="26" height="8" rx="2" fill="#94a3b8"/>
    <!-- Spiky Anime Hair -->
    <path d="M35,44 L30,26 L44,32 L52,16 L60,30 L68,16 L76,32 L90,26 L85,44 C76,35 44,35 35,44 Z" fill="${th.hair}"/>
    <!-- Eyes -->
    <ellipse cx="50" cy="54" rx="4.5" ry="3" fill="#ffffff"/>
    <ellipse cx="70" cy="54" rx="4.5" ry="3" fill="#ffffff"/>
    <circle cx="50" cy="54" r="2.4" fill="${th.eye}"/>
    <circle cx="70" cy="54" r="2.4" fill="${th.eye}"/>
    ${isUchiha ? `<circle cx="50" cy="54" r="1" fill="#000"/><circle cx="70" cy="54" r="1" fill="#000"/>` : ""}
    ${isByakugan ? `<circle cx="50" cy="54" r="2.6" fill="none" stroke="#94a3b8" stroke-width="0.8"/><circle cx="70" cy="54" r="2.6" fill="none" stroke="#94a3b8" stroke-width="0.8"/>` : ""}
    ${isUzumaki ? `<line x1="41" y1="59" x2="46" y2="59" stroke="#7c2d12" stroke-width="1.2"/><line x1="41" y1="62" x2="46" y2="62" stroke="#7c2d12" stroke-width="1.2"/><line x1="74" y1="59" x2="79" y2="59" stroke="#7c2d12" stroke-width="1.2"/><line x1="74" y1="62" x2="79" y2="62" stroke="#7c2d12" stroke-width="1.2"/>` : ""}
    <!-- Mouth -->
    <path d="M54,68 Q60,71 66,68" fill="none" stroke="#7c2d12" stroke-width="1.8" stroke-linecap="round"/>
    <!-- Tier & Monogram Badges -->
    <rect x="6" y="6" width="28" height="16" rx="5" fill="#090d16" fill-opacity="0.85" stroke="${th.accent}" stroke-width="1"/>
    <text x="20" y="17" font-family="system-ui,sans-serif" font-size="10" font-weight="800" fill="${th.accent}" text-anchor="middle">${tier}</text>
    <text x="108" y="112" font-family="system-ui,sans-serif" font-size="10" font-weight="800" fill="#ffffff" fill-opacity="0.7" text-anchor="end">${initials}</text>
  </svg>`;

  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
