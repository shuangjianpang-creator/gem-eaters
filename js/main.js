// Top-level game client. Wires DOM, network, render loop, and input together.
// Pure data + helpers live in sibling modules; this file owns the mutable
// runtime state (current snakes, phase, room, etc.) and the canvas.

import { lerp, lerpAngle, hash, noise2d, escapeHtml, shade, hexToHsl } from './utils.js';
import {
    RANDOM_NAMES, RANDOM_AVATARS, RANDOM_COLORS, COLOR_PALETTE,
    MODES_LIST, THEMES, pickRandom,
} from './themes.js';
import {
    setMuted, setVolume,
    sndEat, sndPowerup, sndDie, sndCountdown, sndStart,
} from './audio.js';
import {
    setParticlesReduceMotion, spawnEatPuff, spawnDeathBurst,
    updateParticles, drawParticles, triggerDeathFlash, drawDeathFlash,
} from './particles.js';

const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");
const myScoreEl = document.getElementById("myScore");
const statusEl = document.getElementById("status");
const leaderboardRowsEl = document.getElementById("leaderboardRows");
const leaderboardEl = document.getElementById("leaderboard");
const roundLabelEl = document.getElementById("roundLabel");
const roundTimeEl = document.getElementById("roundTime");

const overlayEl = document.getElementById("overlay");
const roomsPanelEl = document.getElementById("roomsPanel");
const lobbyPanelEl = document.getElementById("lobbyPanel");
const deathPanelEl = document.getElementById("deathPanel");
const intermissionPanelEl = document.getElementById("intermissionPanel");

const nameInput = document.getElementById("nameInput");
const avatarPickerEl = document.getElementById("avatarPicker");
const avatarCustomEl = document.getElementById("avatarCustom");
const avatarImageFileEl = document.getElementById("avatarImageFile");
const avatarImageButton = document.getElementById("avatarImageButton");
const avatarImageClear = document.getElementById("avatarImageClear");
const avatarImageHint = document.getElementById("avatarImageHint");
const skinColorsEl = document.getElementById("skinColors");
const skinCustomColorEl = document.getElementById("skinCustomColor");
const skinPatternsEl = document.getElementById("skinPatterns");
const skinPreviewEl = document.getElementById("skinPreview");

const roomListEl = document.getElementById("roomList");
const newRoomNameEl = document.getElementById("newRoomName");
const quickPlayButton = document.getElementById("quickPlayButton");
const inviteButton = document.getElementById("inviteButton");
const URL_PARAMS = new URLSearchParams(location.search);
const PENDING_ROOM_FROM_URL = URL_PARAMS.get("room");
let pendingUrlJoinId = null;  // set while we're trying to join via ?room= URL

// ---------------- first-visit tutorial ----------------
const TUTORIAL_KEY = "snakeTutorialSeen";
const TUTORIAL_STEPS = [
    { emoji: '🐍', title: 'Move with your mouse',
      text: 'Your snake follows wherever you point. On touch, drag your finger.' },
    { emoji: '🍎', title: 'Eat to grow',
      text: 'Colored food = +1 score. Special ⚡✦★⌬ items give shields, speed, score multipliers and more — grab them!' },
    { emoji: '💀', title: 'Avoid other snakes',
      text: "Crash your head into another snake's body and you die. Outsmart them, force them to crash into you instead." },
];
function showTutorial() {
    const ov = document.getElementById("tutorialOverlay");
    const emo = document.getElementById("tutEmoji");
    const title = document.getElementById("tutTitle");
    const text = document.getElementById("tutText");
    const next = document.getElementById("tutNext");
    const skip = document.getElementById("tutSkip");
    const dots = ov.querySelectorAll(".tutDot");
    const card = document.getElementById("tutCard");
    let idx = 0;
    function render() {
        const s = TUTORIAL_STEPS[idx];
        card.style.animation = 'none'; void card.offsetWidth; card.style.animation = '';
        emo.textContent = s.emoji;
        title.textContent = s.title;
        text.textContent = s.text;
        dots.forEach((d, i) => d.classList.toggle("active", i === idx));
        next.textContent = idx === TUTORIAL_STEPS.length - 1 ? "Got it!" : "Next →";
    }
    function close() {
        ov.style.display = "none";
        localStorage.setItem(TUTORIAL_KEY, "1");
    }
    next.onclick = () => {
        if (idx >= TUTORIAL_STEPS.length - 1) { close(); return; }
        idx++; render();
    };
    skip.onclick = close;
    render();
    ov.style.display = "";
}
if (!localStorage.getItem(TUTORIAL_KEY)) showTutorial();

// ---------------- cold-start splash ----------------
const loadingSplash = document.getElementById("loadingSplash");
const loadingHint = document.getElementById("loadingHint");
const loadingElapsed = document.getElementById("loadingElapsed");
const SPLASH_T0 = Date.now();
const splashTimer = setInterval(() => {
    if (!loadingSplash || loadingSplash.classList.contains("hide")) {
        clearInterval(splashTimer);
        return;
    }
    const sec = Math.round((Date.now() - SPLASH_T0) / 1000);
    loadingElapsed.textContent = sec > 0 ? `${sec}s elapsed` : "";
    if (sec >= 45) {
        loadingHint.textContent = "Almost there… some free-tier wakeups take a full minute.";
    } else if (sec >= 8) {
        loadingHint.textContent =
            "Server's waking up — free tier sleeps when idle, ~30s on a cold start.";
    } else if (sec >= 3) {
        loadingHint.textContent = "Hang on, server's not quite ready yet…";
    }
}, 1000);

function hideSplash() {
    if (!loadingSplash) return;
    clearInterval(splashTimer);
    loadingSplash.classList.add("hide");
    setTimeout(() => loadingSplash.classList.add("gone"), 500);
}
setTimeout(hideSplash, 90_000);

// ---------------- persistent stats + daily challenges (localStorage) ----------------
const STATS_KEY = "snakeStats";
const DAILY_KEY = "snakeDaily";
const stats = Object.assign(
    { games: 0, wins: 0, foodEaten: 0, powerups: 0, kills: 0, bestScore: 0 },
    JSON.parse(localStorage.getItem(STATS_KEY) || '{}')
);
function saveStats() { localStorage.setItem(STATS_KEY, JSON.stringify(stats)); }

const DAILY_CHALLENGES = [
    { id: 'food50',   icon: '🍎', target: 50, text: 'Eat 50 food items',  metric: 'food' },
    { id: 'power5',   icon: '⭐', target: 5,  text: 'Eat 5 power-ups',     metric: 'powerup' },
    { id: 'win1',     icon: '🏆', target: 1,  text: 'Win 1 round',         metric: 'win' },
    { id: 'kill3',    icon: '💀', target: 3,  text: 'Get 3 kills',         metric: 'kill' },
    { id: 'score40',  icon: '🎯', target: 40, text: 'Reach score 40',      metric: 'best' },
];
function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
function pickTodayChallenge() {
    const key = todayKey();
    const h = [...key].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 0);
    return DAILY_CHALLENGES[h % DAILY_CHALLENGES.length];
}
let daily = JSON.parse(localStorage.getItem(DAILY_KEY) || '{}');
if (daily.day !== todayKey()) {
    daily = { day: todayKey(), challengeId: pickTodayChallenge().id, progress: 0, done: false };
    localStorage.setItem(DAILY_KEY, JSON.stringify(daily));
}
function saveDaily() { localStorage.setItem(DAILY_KEY, JSON.stringify(daily)); }
function currentChallenge() { return DAILY_CHALLENGES.find(c => c.id === daily.challengeId) || DAILY_CHALLENGES[0]; }

function trackEvent(metric, amount = 1) {
    if (metric === 'food')    stats.foodEaten += amount;
    if (metric === 'powerup') stats.powerups  += amount;
    if (metric === 'kill')    stats.kills     += amount;
    if (metric === 'win')     stats.wins      += amount;
    if (metric === 'game')    stats.games     += amount;
    if (metric === 'lssWin')  stats.lssWins = (stats.lssWins || 0) + amount;
    saveStats();
    if (!daily.done) {
        const ch = currentChallenge();
        if (ch.metric === metric) {
            daily.progress = Math.min(ch.target, daily.progress + amount);
            if (daily.progress >= ch.target) { daily.done = true; showChallengeComplete(ch); }
            saveDaily();
            renderDailyChallenge();
        }
    }
    renderStats();
    checkAchievements();
}
function trackCombo(level) {
    if (level > (stats.bestCombo || 0)) {
        stats.bestCombo = level;
        saveStats();
        checkAchievements();
    }
}
function trackBestScore(score) {
    if (score > stats.bestScore) { stats.bestScore = score; saveStats(); renderStats(); }
    if (!daily.done) {
        const ch = currentChallenge();
        if (ch.metric === 'best' && score >= ch.target) {
            daily.done = true; daily.progress = ch.target;
            saveDaily(); renderDailyChallenge(); showChallengeComplete(ch);
        }
    }
}

function renderDailyChallenge() {
    const ch = currentChallenge();
    const el = document.getElementById("dailyChallenge");
    if (!el) return;
    el.classList.toggle("completed", !!daily.done);
    document.getElementById("dailyIcon").textContent = ch.icon;
    document.getElementById("dailyName").textContent = daily.done ? '✓ ' + ch.text : ch.text;
    document.getElementById("dailyStatus").textContent =
        daily.done ? 'COMPLETE' : `${daily.progress} / ${ch.target}`;
    const pct = Math.min(100, (daily.progress / ch.target) * 100);
    document.getElementById("dailyBarFill").style.width = pct + '%';
}
function renderStats() {
    const setText = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    setText("statGames", stats.games);
    setText("statWins",  stats.wins);
    setText("statKills", stats.kills);
    setText("statBest",  stats.bestScore);
}
function showChallengeComplete(ch) {
    const t = document.createElement("div");
    t.id = "challengeCompleteToast";
    t.textContent = `🎉 Daily challenge complete: ${ch.text}`;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3800);
    sndPowerup();
}
renderDailyChallenge();
renderStats();
setTimeout(() => { renderAchievements(); checkAchievements(); }, 0);

// ---------------- achievements (lifetime, localStorage) ----------------
const ACH_KEY = "snakeAchievements";
const ACHIEVEMENTS = [
    { id: 'first_kill',  name: 'First Blood',     icon: '🩸', desc: 'Get your first kill',                check: () => stats.kills >= 1 },
    { id: 'glutton',     name: 'Glutton',          icon: '🍴', desc: 'Eat 1,000 food items total',         check: () => stats.foodEaten >= 1000 },
    { id: 'champion',    name: 'Champion',         icon: '🏆', desc: 'Win 10 rounds',                       check: () => stats.wins >= 10 },
    { id: 'killer_5',    name: 'Killer Instinct',  icon: '⚔️', desc: 'Get 25 kills',                       check: () => stats.kills >= 25 },
    { id: 'power_50',    name: 'Power Hungry',     icon: '⚡', desc: 'Eat 50 power-ups',                   check: () => stats.powerups >= 50 },
    { id: 'score_100',   name: 'Centurion',        icon: '💯', desc: 'Reach 100 in a single round',        check: () => stats.bestScore >= 100 },
    { id: 'score_200',   name: 'High Roller',      icon: '🎯', desc: 'Reach 200 in a single round',        check: () => stats.bestScore >= 200 },
    { id: 'games_25',    name: 'Regular',          icon: '🎮', desc: 'Play 25 games',                       check: () => stats.games >= 25 },
    { id: 'games_100',   name: 'Addict',           icon: '🔥', desc: 'Play 100 games',                      check: () => stats.games >= 100 },
    { id: 'combo_3',     name: 'On Fire',          icon: '🔥', desc: 'Reach a x3 combo',                    check: () => (stats.bestCombo || 0) >= 3 },
    { id: 'combo_5',     name: 'Combo King',       icon: '👑', desc: 'Reach the max x5 combo',              check: () => (stats.bestCombo || 0) >= 5 },
    { id: 'survivor',    name: 'Survivor',         icon: '🛡️', desc: 'Win a Last Snake Standing round',     check: () => (stats.lssWins || 0) >= 1 },
];
let unlockedAch = JSON.parse(localStorage.getItem(ACH_KEY) || '[]');
const unlockedSet = new Set(unlockedAch);
function saveAch() { localStorage.setItem(ACH_KEY, JSON.stringify([...unlockedSet])); }

function checkAchievements() {
    for (const a of ACHIEVEMENTS) {
        if (unlockedSet.has(a.id)) continue;
        if (a.check()) {
            unlockedSet.add(a.id);
            saveAch();
            showAchievementToast(a);
        }
    }
    renderAchievements();
}
function showAchievementToast(a) {
    const t = document.createElement("div");
    t.className = "achToast";
    t.innerHTML = `<div class="achToastIcon">${a.icon}</div>
                   <div><div class="achToastLabel">Achievement unlocked</div>
                        <div class="achToastName">${a.name}</div></div>`;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 4500);
    sndPowerup();
}
function renderAchievements() {
    const el = document.getElementById("achievementsList");
    if (!el) return;
    const total = ACHIEVEMENTS.length;
    const unlocked = unlockedSet.size;
    const header = document.getElementById("achievementsHeader");
    if (header) header.textContent = `Achievements — ${unlocked} / ${total}`;
    el.innerHTML = ACHIEVEMENTS.map(a => {
        const got = unlockedSet.has(a.id);
        return `<div class="achItem ${got ? 'got' : 'locked'}">
            <div class="achIcon">${got ? a.icon : '🔒'}</div>
            <div class="achInfo">
                <div class="achName">${escapeHtml(a.name)}</div>
                <div class="achDesc">${escapeHtml(a.desc)}</div>
            </div>
        </div>`;
    }).join("");
}
const createRoomButton = document.getElementById("createRoomButton");
const roomsErrorEl = document.getElementById("roomsError");

const lobbyRoomNameEl = document.getElementById("lobbyRoomName");
const lobbyPlayerCountEl = document.getElementById("lobbyPlayerCount");
const lobbyPlayersEl = document.getElementById("lobbyPlayers");
const lobbyErrorEl = document.getElementById("lobbyError");
const readyButton = document.getElementById("readyButton");
const startButton = document.getElementById("startButton");
const addBotButton = document.getElementById("addBotButton");
const removeBotButton = document.getElementById("removeBotButton");
const leaveLobbyButton = document.getElementById("leaveLobbyButton");
const mapGridEl = document.getElementById("mapGrid");
const mapHintEl = document.getElementById("mapHint");
const lobbyStatusEl = document.getElementById("lobbyStatus");
const modeGridEl = document.getElementById("modeGrid");
const modeHintEl = document.getElementById("modeHint");
const muteToggleEl = document.getElementById("muteToggle");
const spectatorOverlayEl = document.getElementById("spectatorOverlay");
const spectatorNameEl = document.getElementById("spectatorName");
const profileSlideEl = document.getElementById("profileSlide");
const roomsSlideEl = document.getElementById("roomsSlide");
const slideTitleEl = document.getElementById("slideTitle");
const slideDotsEl = document.querySelector(".slideDots");
const toRoomsButton = document.getElementById("toRoomsButton");
const backToProfileButton = document.getElementById("backToProfileButton");

function showSlide(idx) {
    profileSlideEl.style.display = idx === 0 ? "" : "none";
    roomsSlideEl.style.display   = idx === 1 ? "" : "none";
    slideTitleEl.textContent = idx === 0 ? "Create Your Snake" : "Choose a Room";
    for (const d of slideDotsEl.querySelectorAll(".dot")) {
        d.classList.toggle("active", Number(d.dataset.slide) === idx);
    }
    if (idx === 1) send({ type: "listRooms" });
}
toRoomsButton.addEventListener("click", () => showSlide(1));
backToProfileButton.addEventListener("click", () => showSlide(0));
for (const d of slideDotsEl.querySelectorAll(".dot")) {
    d.addEventListener("click", () => showSlide(Number(d.dataset.slide)));
}

const deathReasonEl = document.getElementById("deathReason");
const respawnButton = document.getElementById("respawnButton");

const intermissionTitleEl = document.getElementById("intermissionTitle");
const intermissionSubEl = document.getElementById("intermissionSub");
const standingsListEl = document.getElementById("standingsList");

// ---------------- identity & local state ----------------
let SAVED_NAME    = localStorage.getItem("snakeName")    || "";
let SAVED_AVATAR  = localStorage.getItem("snakeAvatar")  || "";
let SAVED_COLOR   = localStorage.getItem("snakeColor")   || "";
let SAVED_PATTERN = localStorage.getItem("snakePattern") || "";
if (!SAVED_NAME) {
    SAVED_NAME = pickRandom(RANDOM_NAMES) + ' ' + Math.floor(Math.random() * 900 + 100);
    localStorage.setItem("snakeName", SAVED_NAME);
}
if (!SAVED_AVATAR)  { SAVED_AVATAR  = pickRandom(RANDOM_AVATARS); localStorage.setItem("snakeAvatar",  SAVED_AVATAR); }
if (!SAVED_COLOR)   { SAVED_COLOR   = pickRandom(RANDOM_COLORS);  localStorage.setItem("snakeColor",   SAVED_COLOR); }
if (!SAVED_PATTERN) { SAVED_PATTERN = 'solid';                    localStorage.setItem("snakePattern", SAVED_PATTERN); }
nameInput.value = SAVED_NAME;

let myId = null;
let world = { width: 3000, height: 3000 };
let mouse = { x: canvas.width / 2, y: 100 };

let myName = SAVED_NAME;
let myAvatar = SAVED_AVATAR;
let selectedAvatar = SAVED_AVATAR;
let myColor = SAVED_COLOR;
let myPattern = SAVED_PATTERN;
let myAvatarImage = localStorage.getItem("snakeAvatarImage") || null;
let isReady = false;

const playerImages = new Map();
const activeEmotes = new Map();

// ---------------- Obstacles (theme-colored deadly props) ----------------
function drawObstacles() {
    if (!obstacles || !obstacles.length) return;
    const isLava  = currentThemeId === 'lava';
    const isSnow  = currentThemeId === 'snow';
    const lightTop = isLava ? '#ff8830' : isSnow ? '#ffffff' : '#6a6a72';
    const baseMid  = isLava ? '#7a1410' : isSnow ? '#506480' : '#2a2a30';
    const darkRim  = isLava ? '#1a0606' : isSnow ? '#1c2a40' : '#0a0a0e';
    const glow     = isLava ? '#ff6020' : isSnow ? '#c0d0e0' : '#000000';
    const rimColor = isLava ? '#ffa040' : isSnow ? '#ffffff' : '#5a5a60';
    for (const o of obstacles) {
        // Pronounced ground shadow (offset down-right)
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.beginPath();
        ctx.ellipse(o.x + 4, o.y + 8, o.r * 1.15, o.r * 0.5, 0, 0, Math.PI * 2);
        ctx.fill();
        // 3D bevel via radial gradient (lit from upper-left)
        ctx.save();
        if (isLava) { ctx.shadowColor = glow; ctx.shadowBlur = 14; }
        const grad = ctx.createRadialGradient(
            o.x - o.r * 0.5, o.y - o.r * 0.5, 1,
            o.x, o.y, o.r,
        );
        grad.addColorStop(0,    lightTop);
        grad.addColorStop(0.55, baseMid);
        grad.addColorStop(1,    darkRim);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(o.x, o.y, o.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        // Rim
        ctx.strokeStyle = rimColor;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(o.x, o.y, o.r, 0, Math.PI * 2);
        ctx.stroke();
        // Bright specular cap
        ctx.fillStyle = isLava ? 'rgba(255,220,140,0.65)' : 'rgba(255,255,255,0.4)';
        ctx.beginPath();
        ctx.ellipse(o.x - o.r * 0.42, o.y - o.r * 0.45, o.r * 0.35, o.r * 0.18, -0.5, 0, Math.PI * 2);
        ctx.fill();
    }
}

// ---------------- KOTH hill ----------------
function drawHill() {
    if (!hill) return;
    const { cx, cy, r } = hill;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0, 'rgba(250, 204, 21, 0.22)');
    grad.addColorStop(1, 'rgba(250, 204, 21, 0.06)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    const pulse = 0.6 + 0.4 * Math.sin(Date.now() / 320);
    ctx.save();
    ctx.shadowColor = '#facc15';
    ctx.shadowBlur = 14;
    ctx.strokeStyle = `rgba(250, 204, 21, ${pulse})`;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = 'rgba(250, 204, 21, 0.55)';
    ctx.font = `${Math.round(r * 0.42)}px Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('👑', cx, cy);
}

// ---------------- LSS: the map IS the circle ----------------
function drawCircularWall() {
    if (!safeZone) return;
    const { cx, cy, r } = safeZone;
    const WALL_THICKNESS = 26;

    ctx.save();
    ctx.fillStyle = '#03050a';
    ctx.beginPath();
    ctx.rect(cx - 6000, cy - 6000, 12000, 12000);
    ctx.arc(cx, cy, r, 0, Math.PI * 2, true);
    ctx.closePath();
    ctx.fill('evenodd');
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = '#3a3a40';
    ctx.lineWidth = WALL_THICKNESS;
    ctx.beginPath();
    ctx.arc(cx, cy, r + WALL_THICKNESS / 2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = '#5a5a60';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r + WALL_THICKNESS, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = '#181820';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r + 1, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // Inner-edge depth: radial gradient darkens the play area's outer rim,
    // selling the illusion that the arena floor sits below the wall lip.
    const innerShadow = ctx.createRadialGradient(cx, cy, Math.max(0, r - 26), cx, cy, r);
    innerShadow.addColorStop(0, 'rgba(0,0,0,0)');
    innerShadow.addColorStop(1, 'rgba(0,0,0,0.5)');
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = innerShadow;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.restore();

    const pulse = 0.55 + 0.35 * Math.sin(Date.now() / 240);
    ctx.save();
    ctx.shadowColor = '#f85149';
    ctx.shadowBlur = 16;
    ctx.strokeStyle = `rgba(248, 81, 73, ${pulse})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, cy, r - 2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
}

// ---------------- mute toggle ----------------
let audioMuted = localStorage.getItem("snakeMuted") === "1";
setMuted(audioMuted);
muteToggleEl.textContent = audioMuted ? "🔇" : "🔊";
muteToggleEl.addEventListener("click", () => {
    audioMuted = !audioMuted;
    setMuted(audioMuted);
    localStorage.setItem("snakeMuted", audioMuted ? "1" : "0");
    muteToggleEl.textContent = audioMuted ? "🔇" : "🔊";
});

// Settings (volume + reduce motion) persisted to localStorage
const settings = Object.assign(
    { volume: 0.7, reduceMotion: false },
    JSON.parse(localStorage.getItem("snakeSettings") || "{}")
);
function saveSettings() { localStorage.setItem("snakeSettings", JSON.stringify(settings)); }
setVolume(settings.volume);
setParticlesReduceMotion(settings.reduceMotion);

const settingsToggle = document.getElementById("settingsToggle");
const settingsOverlay = document.getElementById("settingsOverlay");
const settingVolume = document.getElementById("settingVolume");
const settingVolumeLabel = document.getElementById("settingVolumeLabel");
const settingReduceMotion = document.getElementById("settingReduceMotion");
const settingsClose = document.getElementById("settingsClose");

settingVolume.value = Math.round(settings.volume * 100);
settingVolumeLabel.textContent = settingVolume.value + "%";
settingReduceMotion.checked = settings.reduceMotion;

settingsToggle.addEventListener("click", () => { settingsOverlay.style.display = ""; });
settingsClose.addEventListener("click", () => { settingsOverlay.style.display = "none"; });
settingsOverlay.addEventListener("click", (e) => { if (e.target === settingsOverlay) settingsOverlay.style.display = "none"; });
settingVolume.addEventListener("input", () => {
    settings.volume = settingVolume.value / 100;
    setVolume(settings.volume);
    settingVolumeLabel.textContent = settingVolume.value + "%";
    saveSettings();
});
settingReduceMotion.addEventListener("change", () => {
    settings.reduceMotion = settingReduceMotion.checked;
    setParticlesReduceMotion(settings.reduceMotion);
    saveSettings();
});

// Emote wheel: toggle visibility, send chosen emote, auto-close
const emoteToggle = document.getElementById("emoteToggle");
const emoteWheel  = document.getElementById("emoteWheel");
emoteToggle.addEventListener("click", () => {
    emoteWheel.style.display = (emoteWheel.style.display === "none") ? "" : "none";
});
for (const btn of emoteWheel.querySelectorAll(".emoteBtn")) {
    btn.addEventListener("click", () => {
        const emote = btn.dataset.emote;
        if (phase === "playing" && !isDead && !meEliminated) {
            send({ type: "emote", emote });
        }
        emoteWheel.style.display = "none";
    });
}

let roomList = [];
let currentRoom = null;
let lobbyPlayers = [];
let phase = "none";
let phaseEndsAt = 0;
let roundNumber = 0;
let currentMode = "ffa";
let myEffects = { goldRemain: 0, shieldRemain: 0, speedRemain: 0, magnetRemain: 0 };
let meEliminated = false;
let prevMyScore = 0;
let prevFoodIds = new Set();
let safeZone = null;
let spectatingId = null;
let obstacles = [];
let hill = null;
let itPlayerId = null;
let bombHolderId = null;
let bombExpiresAt = 0;

let renderSnakes = [];
let targetSnakes = [];
let foodList = [];
let leaderboard = [];
let standings = null;
let isDead = false;
let lastDeathReason = "wall";
let lastDeathScore = 0;
let lastKiller = null;

let ws = null;

let currentTheme = THEMES.grasslands;
let currentThemeId = 'grasslands';
let availableMaps = [{ id: 'grasslands', name: 'Grasslands', theme: 'grasslands', size: 3000 }];

function applyMap(mapInfo) {
    if (!mapInfo) return;
    currentThemeId = THEMES[mapInfo.theme] ? mapInfo.theme : 'grasslands';
    currentTheme = THEMES[currentThemeId];
    world = { width: mapInfo.size, height: mapInfo.size };
}

// ---------------- websocket ----------------
function connect() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}`);
    ws.onopen = () => {
        statusEl.textContent = "connected";
        sendIdentity();
    };
    ws.onclose = () => {
        statusEl.textContent = "reconnecting...";
        setTimeout(connect, 1000);
    };
    ws.onerror = () => { statusEl.textContent = "error"; };
    ws.onmessage = handleMessage;
}

function sendIdentity() {
    if (!ws || ws.readyState !== 1) return;
    if (myName)   ws.send(JSON.stringify({ type: "setName", name: myName }));
    if (myAvatar) ws.send(JSON.stringify({ type: "setAvatar", avatar: myAvatar }));
    ws.send(JSON.stringify({ type: "setSkin", color: myColor, pattern: myPattern }));
    if (myAvatarImage) ws.send(JSON.stringify({ type: "setAvatarImage", dataUrl: myAvatarImage }));
}

function send(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

function handleMessage(event) {
    const msg = JSON.parse(event.data);
    switch (msg.type) {
        case "welcome":
            myId = msg.id;
            world = msg.world;
            hideSplash();
            if (PENDING_ROOM_FROM_URL && !currentRoom) {
                pendingUrlJoinId = PENDING_ROOM_FROM_URL;
                send({ type: "joinRoom", roomId: PENDING_ROOM_FROM_URL });
            }
            if (myAvatarImage) {
                const img = new Image();
                img.onload = () => drawSkinPreview();
                img.src = myAvatarImage;
                playerImages.set(myId, img);
            }
            break;
        case "playerImage":
            if (msg.dataUrl) {
                const img = new Image();
                img.src = msg.dataUrl;
                playerImages.set(msg.id, img);
            } else {
                playerImages.delete(msg.id);
            }
            break;
        case "roomList":
            roomList = msg.rooms;
            if (!currentRoom) renderRoomList();
            break;
        case "joinedRoom":
            currentRoom = { id: msg.roomId, ownerId: msg.ownerId, name: "" };
            phase = "lobby";
            isReady = false;
            pendingUrlJoinId = null;
            try { history.replaceState(null, "", `?room=${msg.roomId}`); } catch {}
            showScreen("lobby");
            break;
        case "leftRoom":
            currentRoom = null;
            lobbyPlayers = [];
            phase = "none";
            isDead = false;
            try { history.replaceState(null, "", location.pathname); } catch {}
            if (msg.reason) showRoomsError(msg.reason);
            showScreen("rooms");
            break;
        case "lobbyState":
            currentRoom = msg.room;
            lobbyPlayers = msg.players;
            phase = msg.phase;
            if (msg.availableMaps) availableMaps = msg.availableMaps;
            applyMap(msg.map);
            const meInLobby = lobbyPlayers.find(p => p.id === myId);
            if (meInLobby) isReady = meInLobby.ready;
            renderLobby();
            if (currentScreen !== "lobby") showScreen("lobby");
            break;
        case "gameState": {
            const prevPhase = phase;
            const prevFood = foodList;
            targetSnakes = msg.snakes;
            foodList = msg.food;
            leaderboard = msg.leaderboard;
            phase = msg.phase;
            phaseEndsAt = msg.phaseEndsAt;
            roundNumber = msg.roundNumber;
            standings = msg.standings;
            currentRoom = msg.room;
            if (msg.room && msg.room.mode) currentMode = msg.room.mode;
            if (msg.myEffects) myEffects = msg.myEffects;
            meEliminated = !!msg.meEliminated;
            spectatingId = msg.spectatingId || null;
            safeZone = msg.safeZone || null;
            obstacles = msg.obstacles || [];
            hill = msg.hill || null;
            itPlayerId = msg.itPlayerId || null;
            bombHolderId = msg.bombHolderId || null;
            bombExpiresAt = msg.bombExpiresAt || 0;
            applyMap(msg.map);

            const mySnake = msg.snakes.find(s => s.id === myId);
            if (mySnake && mySnake.combo) trackCombo(mySnake.combo);
            if (mySnake && prevFood && foodList) {
                const currentIds = new Set(foodList.map(f => f.id));
                for (const f of prevFood) {
                    if (currentIds.has(f.id)) continue;
                    const dx = f.x - mySnake.x, dy = f.y - mySnake.y;
                    if (dx * dx + dy * dy < 40 * 40) {
                        spawnEatPuff(f.x, f.y, f.color || '#ff7b72');
                        if (f.type && f.type !== 'regular') {
                            sndPowerup();
                            spawnEatPuff(f.x, f.y, powerupColor(f.type));
                            spawnEatPuff(f.x, f.y, '#ffffff');
                            trackEvent('powerup');
                        } else {
                            sndEat();
                            trackEvent('food');
                        }
                    }
                }
            }
            const me = leaderboard.find(p => p.id === myId);
            myScoreEl.textContent = me ? me.score : 0;

            if (phase !== prevPhase) {
                if (phase === "intermission") {
                    isDead = false;
                    showScreen("intermission");
                    trackEvent('game');
                    if (msg.standings && msg.standings.length > 0 && msg.standings[0].id === myId) {
                        trackEvent('win');
                        if (currentMode === 'lastman') trackEvent('lssWin');
                    }
                    if (me) trackBestScore(me.score);
                } else if (phase === "playing" && prevPhase !== "playing") {
                    isDead = false;
                    showScreen("none");
                }
            }
            if (phase === "playing" && isDead && me && me.alive) {
                isDead = false;
                showScreen("none");
            }
            if (phase === "playing" && me) trackBestScore(me.score);
            break;
        }
        case "died":
            if (phase === "playing") {
                isDead = true;
                lastDeathReason = msg.reason;
                lastDeathScore = msg.finalScore;
                meEliminated = !!msg.eliminated;
                lastKiller = msg.killerId ? {
                    id: msg.killerId,
                    name: msg.killerName,
                    avatar: msg.killerAvatar,
                    color: msg.killerColor,
                    score: msg.killerScore,
                } : null;
                const me = renderSnakes.find(s => s.id === myId);
                if (me) spawnDeathBurst(me);
                triggerDeathFlash();
                sndDie();
                showDeathPanel();
                if (meEliminated) {
                    setTimeout(() => {
                        if (meEliminated && phase === "playing") showScreen("none");
                    }, 2500);
                }
            }
            break;
        case "kill":
            showKillToast(msg.victimName, msg.victimAvatar, msg.victimScore);
            trackEvent('kill');
            break;
        case "playerEmote":
            activeEmotes.set(msg.id, { emote: msg.emote, until: Date.now() + 2200 });
            break;
        case "error":
            if (pendingUrlJoinId && msg.message === 'Room not found') {
                const stale = pendingUrlJoinId;
                pendingUrlJoinId = null;
                try { history.replaceState(null, "", location.pathname); } catch {}
                showRoomsError(
                    `That invite link's room (${stale}) doesn't exist anymore — ` +
                    `it expires whenever the server restarts. ` +
                    `Click Quick Play or create a new room and share its link.`
                );
                break;
            }
            if (currentScreen === "lobby") showLobbyError(msg.message);
            else                          showRoomsError(msg.message);
            break;
    }
}

// ---------------- screen state machine ----------------
let currentScreen = "rooms";

function showScreen(name) {
    currentScreen = name;
    roomsPanelEl.style.display       = name === "rooms"        ? "" : "none";
    lobbyPanelEl.style.display       = name === "lobby"        ? "" : "none";
    deathPanelEl.style.display       = name === "death"        ? "" : "none";
    intermissionPanelEl.style.display= name === "intermission" ? "" : "none";
    if (name === "none") overlayEl.classList.add("hidden");
    else                 overlayEl.classList.remove("hidden");
    if (name === "rooms") {
        send({ type: "listRooms" });
        showSlide(SAVED_NAME ? 1 : 0);
    }
}

function showRoomsError(msg) {
    roomsErrorEl.textContent = msg;
    roomsErrorEl.style.display = "";
    setTimeout(() => { roomsErrorEl.style.display = "none"; }, 4000);
}
function showLobbyError(msg) {
    lobbyErrorEl.textContent = msg;
    lobbyErrorEl.style.display = "";
    setTimeout(() => { lobbyErrorEl.style.display = "none"; }, 4000);
}

// ---------------- rooms panel ----------------
function renderRoomList() {
    if (!roomList.length) {
        roomListEl.innerHTML = `<div class="empty">No active rooms. Create one!</div>`;
        return;
    }
    roomListEl.innerHTML = roomList.map(r => {
        const joinable = r.phase === 'lobby' && r.playerCount < r.maxPlayers;
        const status = r.phase === 'lobby' ? 'lobby' : r.phase === 'playing' ? 'playing' : 'between rounds';
        const btn = joinable
            ? `<button data-room-id="${r.id}" class="joinBtn">Join</button>`
            : `<button disabled>${r.phase === 'lobby' ? 'Full' : 'In game'}</button>`;
        return `<div class="room">
            <div>
                <div>${escapeHtml(r.name)}</div>
                <div class="meta">${r.playerCount}/${r.maxPlayers} &bull; ${status}</div>
            </div>
            ${btn}
        </div>`;
    }).join("");
    for (const b of roomListEl.querySelectorAll(".joinBtn")) {
        b.addEventListener("click", () => {
            commitIdentity();
            send({ type: "joinRoom", roomId: b.dataset.roomId });
        });
    }
}

createRoomButton.addEventListener("click", () => {
    commitIdentity();
    const name = newRoomNameEl.value.trim();
    send({ type: "createRoom", name });
    newRoomNameEl.value = "";
});

quickPlayButton.addEventListener("click", () => {
    commitIdentity();
    send({ type: "quickPlay" });
});

inviteButton.addEventListener("click", async () => {
    if (!currentRoom) return;
    const url = `${location.origin}${location.pathname}?room=${currentRoom.id}`;
    try {
        await navigator.clipboard.writeText(url);
        inviteButton.textContent = "✓ Copied to clipboard";
        inviteButton.classList.add("copied");
        setTimeout(() => {
            inviteButton.textContent = "🔗 Copy invite link";
            inviteButton.classList.remove("copied");
        }, 1800);
    } catch {
        prompt("Copy this link to invite friends:", url);
    }
});

nameInput.addEventListener("input", () => {
    myName = nameInput.value.trim() || "anon";
    localStorage.setItem("snakeName", myName);
    if (ws && ws.readyState === 1) send({ type: "setName", name: myName });
});

function commitIdentity() {
    myName = nameInput.value.trim() || "anon";
    localStorage.setItem("snakeName", myName);
    localStorage.setItem("snakeAvatar", myAvatar);
    localStorage.setItem("snakeColor", myColor);
    localStorage.setItem("snakePattern", myPattern);
    sendIdentity();
}

// avatar picker
function selectAvatar(emoji) {
    selectedAvatar = emoji;
    myAvatar = emoji;
    avatarCustomEl.value = "";
    for (const el of avatarPickerEl.querySelectorAll(".preset")) {
        el.classList.toggle("selected", el.dataset.emoji === emoji);
    }
    localStorage.setItem("snakeAvatar", emoji);
    if (ws && ws.readyState === 1) send({ type: "setAvatar", avatar: emoji });
    drawSkinPreview();
}
for (const el of avatarPickerEl.querySelectorAll(".preset")) {
    el.addEventListener("click", () => selectAvatar(el.dataset.emoji));
}
avatarCustomEl.addEventListener("input", () => {
    const val = avatarCustomEl.value.trim();
    if (val) {
        selectedAvatar = val;
        myAvatar = val;
        for (const el of avatarPickerEl.querySelectorAll(".preset")) el.classList.remove("selected");
        localStorage.setItem("snakeAvatar", val);
        if (ws && ws.readyState === 1) send({ type: "setAvatar", avatar: val });
        drawSkinPreview();
    }
});
selectAvatar(SAVED_AVATAR);

// --- Avatar photo upload ---
avatarImageButton.addEventListener("click", () => avatarImageFileEl.click());
avatarImageFileEl.addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
        const dataUrl = await cropAvatarImage(file);
        setMyAvatarImage(dataUrl);
        avatarImageHint.textContent = "Uploaded ✓";
    } catch (err) {
        avatarImageHint.textContent = "Couldn't read image";
        avatarImageHint.style.color = "#f85149";
        console.warn(err);
    }
    avatarImageFileEl.value = "";
});
avatarImageClear.addEventListener("click", () => setMyAvatarImage(null));

function setMyAvatarImage(dataUrl) {
    myAvatarImage = dataUrl;
    if (dataUrl) {
        localStorage.setItem("snakeAvatarImage", dataUrl);
        avatarImageClear.style.display = "";
    } else {
        localStorage.removeItem("snakeAvatarImage");
        avatarImageClear.style.display = "none";
        avatarImageHint.textContent = "Auto-cropped to circle";
        avatarImageHint.style.color = "#8b949e";
    }
    if (myId != null) {
        if (dataUrl) {
            const img = new Image();
            img.onload = () => { drawSkinPreview(); };
            img.src = dataUrl;
            playerImages.set(myId, img);
        } else {
            playerImages.delete(myId);
        }
    }
    if (ws && ws.readyState === 1) send({ type: "setAvatarImage", dataUrl });
    drawSkinPreview();
}

// Center-crop incoming image to a square, resize to 96×96, JPEG-encode.
async function cropAvatarImage(file) {
    if (file.size > 8 * 1024 * 1024) throw new Error("Image too large (>8MB)");
    const dataUrl = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(new Error("FileReader failed"));
        r.readAsDataURL(file);
    });
    const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error("Image load failed"));
        i.src = dataUrl;
    });
    const size = Math.min(img.width, img.height);
    const sx = (img.width - size) / 2;
    const sy = (img.height - size) / 2;
    const out = document.createElement("canvas");
    out.width = 96; out.height = 96;
    const o = out.getContext("2d");
    o.drawImage(img, sx, sy, size, size, 0, 0, 96, 96);
    return out.toDataURL("image/jpeg", 0.82);
}

if (myAvatarImage) {
    avatarImageClear.style.display = "";
    avatarImageHint.textContent = "Uploaded ✓";
}

// skin colors
skinColorsEl.innerHTML = COLOR_PALETTE.map(c =>
    `<div class="swatch" data-c="${c}" style="background:${c}"></div>`
).join("");
function selectColor(c) {
    myColor = c;
    localStorage.setItem("snakeColor", c);
    skinCustomColorEl.value = c;
    for (const el of skinColorsEl.querySelectorAll(".swatch")) {
        el.classList.toggle("selected", el.dataset.c === c);
    }
    if (ws && ws.readyState === 1) send({ type: "setSkin", color: myColor, pattern: myPattern });
    drawSkinPreview();
}
for (const el of skinColorsEl.querySelectorAll(".swatch")) {
    el.addEventListener("click", () => selectColor(el.dataset.c));
}
skinCustomColorEl.addEventListener("input", () => {
    myColor = skinCustomColorEl.value;
    localStorage.setItem("snakeColor", myColor);
    for (const el of skinColorsEl.querySelectorAll(".swatch")) el.classList.remove("selected");
    if (ws && ws.readyState === 1) send({ type: "setSkin", color: myColor, pattern: myPattern });
    drawSkinPreview();
});
selectColor(SAVED_COLOR);

// skin patterns
function selectPattern(p) {
    myPattern = p;
    localStorage.setItem("snakePattern", p);
    for (const b of skinPatternsEl.querySelectorAll("button")) {
        b.classList.toggle("selected", b.dataset.pattern === p);
    }
    if (ws && ws.readyState === 1) send({ type: "setSkin", color: myColor, pattern: myPattern });
    drawSkinPreview();
}
for (const b of skinPatternsEl.querySelectorAll("button")) {
    b.addEventListener("click", () => selectPattern(b.dataset.pattern));
}
selectPattern(SAVED_PATTERN);

function drawSkinPreview() {
    const pctx = skinPreviewEl.getContext("2d");
    pctx.clearRect(0, 0, skinPreviewEl.width, skinPreviewEl.height);
    const total = 13;
    const cy = skinPreviewEl.height / 2;
    const HEAD_R = 10;
    const SEG_STEP = 12;
    const HEAD_X = 14;
    for (let i = total - 1; i >= 0; i--) {
        const x = HEAD_X + i * SEG_STEP;
        const taper = (total - i) / total;
        const r = Math.max(7 * Math.sin(taper * Math.PI / 2), 1.5);
        pctx.beginPath();
        pctx.arc(x, cy, r, 0, Math.PI * 2);
        pctx.fillStyle = segmentColorRaw(myColor, myPattern, i, total);
        pctx.fill();
    }
    pctx.beginPath();
    pctx.arc(HEAD_X, cy, HEAD_R, 0, Math.PI * 2);
    pctx.fillStyle = shade(myColor, 10);
    pctx.fill();
    const previewImg = myId != null ? playerImages.get(myId) : null;
    if (previewImg && previewImg.complete && previewImg.naturalWidth > 0) {
        pctx.save();
        pctx.beginPath(); pctx.arc(HEAD_X, cy, HEAD_R - 0.5, 0, Math.PI * 2); pctx.clip();
        pctx.drawImage(previewImg, HEAD_X - HEAD_R, cy - HEAD_R, HEAD_R * 2, HEAD_R * 2);
        pctx.restore();
    } else if (myAvatar) {
        pctx.save();
        pctx.beginPath(); pctx.arc(HEAD_X, cy, HEAD_R, 0, Math.PI * 2); pctx.clip();
        pctx.font = "14px sans-serif";
        pctx.textAlign = "center";
        pctx.textBaseline = "middle";
        pctx.fillText(myAvatar, HEAD_X, cy + 1);
        pctx.restore();
    }
}

// ---------------- lobby panel ----------------
function renderLobby() {
    if (!currentRoom) return;

    // The server broadcasts lobbyState at 30 Hz. Re-running this function
    // every tick wipes the DOM via innerHTML — that destroys cards mid-click
    // and the browser drops the click event (mousedown on old element,
    // mouseup on new element). Cache the inputs and skip work when unchanged.
    const dataKey = JSON.stringify({
        id: currentRoom.id,
        n:  currentRoom.name,
        o:  currentRoom.ownerId,
        m:  currentRoom.mapId,
        g:  currentRoom.mode,
        p:  lobbyPlayers,
        a:  availableMaps.map(m => m.id),
        r:  isReady,
    });
    if (renderLobby._lastKey === dataKey) return;
    renderLobby._lastKey = dataKey;

    lobbyRoomNameEl.textContent = currentRoom.name || "Room";
    lobbyPlayerCountEl.textContent = lobbyPlayers.length;
    const roomCodeValueEl = document.getElementById("roomCodeValue");
    if (roomCodeValueEl) roomCodeValueEl.textContent = currentRoom.id || "—";

    const amOwnerLobby = currentRoom.ownerId === myId;

    modeHintEl.textContent = amOwnerLobby ? "Click a mode" : "Chosen by room owner";
    const currentModeId = (currentRoom.mode || 'ffa');
    modeGridEl.innerHTML = MODES_LIST.map(m => {
        const selected = m.id === currentModeId;
        return `<div class="modeCard${selected ? ' selected' : ''}${amOwnerLobby ? '' : ' disabled'}" data-mode-id="${m.id}">
            <div class="mIcon">${m.icon}</div>
            <div class="mName">${escapeHtml(m.name)}</div>
            <div class="mDesc">${escapeHtml(m.description)}</div>
        </div>`;
    }).join("");
    if (amOwnerLobby) {
        for (const card of modeGridEl.querySelectorAll(".modeCard")) {
            card.addEventListener("click", () => {
                if (card.dataset.modeId !== currentModeId) {
                    send({ type: "setMode", mode: card.dataset.modeId });
                }
            });
        }
    }

    mapHintEl.textContent = amOwnerLobby ? "Click a map to choose" : "Chosen by room owner";
    mapGridEl.innerHTML = availableMaps.map(m => {
        const theme = THEMES[m.theme] || THEMES.grasslands;
        const selected = m.id === currentRoom.mapId;
        const palette = [theme.patchDark, theme.base, theme.patchLight, theme.patchBright, theme.bladeLight]
            .map(c => `<div style="background:${c}"></div>`).join("");
        return `<div class="mapCard${selected ? " selected" : ""}${amOwnerLobby ? "" : " disabled"}" data-map-id="${m.id}">
            <div class="row1">
                <span class="mIcon">${m.icon || "🗺️"}</span>
                <span class="mName">${escapeHtml(m.name)}</span>
                ${selected ? '<span class="mCheck">✓</span>' : ''}
            </div>
            <div class="mDesc">${escapeHtml(m.description || "")}</div>
            <div class="mStats">${m.size}² &bull; ${m.foodCount} food</div>
            <div class="mPalette">${palette}</div>
        </div>`;
    }).join("");
    if (amOwnerLobby) {
        for (const card of mapGridEl.querySelectorAll(".mapCard")) {
            card.addEventListener("click", () => {
                if (card.dataset.mapId !== currentRoom.mapId) {
                    send({ type: "setMap", mapId: card.dataset.mapId });
                }
            });
        }
    }
    lobbyPlayersEl.innerHTML = lobbyPlayers.map(p => {
        const isMe = p.id === myId;
        const ownerTag = p.isOwner ? `<span class="owner">👑 OWNER</span>` : "";
        const botTag = p.isBot ? `<span class="botTag">🤖 BOT</span>` : "";
        const readyTag = p.ready
            ? `<span class="ready">✅ Ready</span>`
            : `<span class="notReady">⬜ Not ready</span>`;
        return `<div class="player">
            <div class="swatch" style="background:${p.color}"></div>
            <div class="av">${escapeHtml(p.avatar || '')}</div>
            <div class="nm ${isMe ? 'me' : ''}">${escapeHtml(p.name)}${isMe ? ' (you)' : ''}</div>
            ${botTag}
            ${ownerTag}
            ${readyTag}
        </div>`;
    }).join("");

    readyButton.textContent = isReady ? "Cancel Ready" : "Get Ready";
    readyButton.classList.toggle("secondary", isReady);

    const amOwner = currentRoom.ownerId === myId;
    startButton.style.display = amOwner ? "" : "none";
    addBotButton.style.display = amOwner ? "" : "none";
    addBotButton.disabled = lobbyPlayers.length >= 8;
    const botCount = lobbyPlayers.filter(p => p.isBot).length;
    removeBotButton.style.display = (amOwner && botCount > 0) ? "" : "none";
    const readyCount = lobbyPlayers.filter(p => p.ready).length;
    const allReady = lobbyPlayers.length > 0 && readyCount === lobbyPlayers.length;
    startButton.disabled = !allReady;
    startButton.textContent = allReady ? "Start Game" : `Waiting (${readyCount}/${lobbyPlayers.length})`;

    if (lobbyPlayers.length <= 1) {
        lobbyStatusEl.textContent = "Waiting for more players to join...";
    } else if (allReady) {
        lobbyStatusEl.textContent = amOwner
            ? "All ready — press Start Game to begin"
            : "All ready — waiting for the owner to start the game";
    } else {
        lobbyStatusEl.textContent = `${readyCount} of ${lobbyPlayers.length} players ready`;
    }
}

readyButton.addEventListener("click", () => {
    isReady = !isReady;
    send({ type: "setReady", ready: isReady });
});
startButton.addEventListener("click", () => send({ type: "startGame" }));
addBotButton.addEventListener("click", () => send({ type: "addBot" }));
removeBotButton.addEventListener("click", () => send({ type: "removeBot" }));
leaveLobbyButton.addEventListener("click", () => send({ type: "leaveRoom" }));

// ---------------- death + intermission panels ----------------
function showDeathPanel() {
    const reasonText = lastDeathReason === 'wall'     ? "Hit the wall."
                     : lastDeathReason === 'zone'     ? "Caught outside the shrinking zone!"
                     : lastDeathReason === 'obstacle' ? "Hit an obstacle."
                     : lastDeathReason === 'bomb'     ? "BOOM! Caught holding the bomb."
                     : "Ran into another snake.";
    deathReasonEl.textContent = `${reasonText} Final score: ${lastDeathScore}`;
    const killerBlock = document.getElementById("killerBlock");
    if (lastKiller && lastDeathReason === 'snake') {
        document.getElementById("killerAvatar").textContent = lastKiller.avatar || "🐍";
        document.getElementById("killerAvatar").style.background = lastKiller.color || "#56d364";
        document.getElementById("killerName").textContent = lastKiller.name || "anon";
        document.getElementById("killerScore").textContent = lastKiller.score || 0;
        killerBlock.style.display = "";
    } else {
        killerBlock.style.display = "none";
    }
    showScreen("death");
}

const killToastEl = document.getElementById("killToast");
const killToastVictimEl = document.getElementById("killToastVictim");
const killToastScoreEl = document.getElementById("killToastScore");
const killToastIconEl = document.getElementById("killToastIcon");
function showKillToast(victimName, victimAvatar, victimScore) {
    killToastIconEl.textContent = victimAvatar || "💀";
    killToastVictimEl.textContent = victimName || "anon";
    killToastScoreEl.textContent = victimScore || 0;
    killToastEl.style.display = "";
    killToastEl.style.animation = 'none';
    void killToastEl.offsetWidth;
    killToastEl.style.animation = '';
    clearTimeout(showKillToast._t);
    showKillToast._t = setTimeout(() => { killToastEl.style.display = "none"; }, 2500);
    sndPowerup();
}
respawnButton.addEventListener("click", () => {
    send({ type: "respawn" });
    showScreen("none");
});

function renderIntermission() {
    if (!standings) return;
    intermissionTitleEl.textContent = `Round ${roundNumber} over`;
    const sec = Math.max(0, Math.ceil((phaseEndsAt - Date.now()) / 1000));
    intermissionSubEl.textContent = `Returning to lobby in ${sec}s`;
    standingsListEl.innerHTML = standings.map((s, i) => {
        const cls = i === 0 ? "standing winner" : "standing";
        return `<div class="${cls}">
            <span class="rank">${i + 1}.</span>
            <span class="av">${escapeHtml(s.avatar || "")}</span>
            <span class="nm">${escapeHtml(s.name)}</span>
            <span class="sc">${s.score}</span>
        </div>`;
    }).join("");
}

// ---------------- input ----------------
canvas.addEventListener("mousemove", (event) => {
    const rect = canvas.getBoundingClientRect();
    mouse.x = event.clientX - rect.left;
    mouse.y = event.clientY - rect.top;
    mouse.set = true;
});

canvas.addEventListener("touchmove", (e) => {
    if (e.touches.length >= 1 && phase === "playing") {
        const rect = canvas.getBoundingClientRect();
        const t = e.touches[0];
        mouse.x = t.clientX - rect.left;
        mouse.y = t.clientY - rect.top;
        mouse.set = true;
    }
}, { passive: true });

function me() { return renderSnakes.find(s => s.id === myId); }

function focusSnake() {
    if (meEliminated && spectatingId != null) {
        const t = renderSnakes.find(s => s.id === spectatingId);
        if (t) return t;
    }
    return me();
}

// Zoom out as the snake grows.
function snakeZoom() {
    const m = focusSnake();
    if (!m) return 1;
    const baseLen = 15;
    const len = m.body.length;
    const t = Math.min(1, Math.max(0, (len - baseLen) / 50));
    return 1 - t * 0.35;
}

function cameraOffset() {
    const z = snakeZoom();
    const m = focusSnake();
    const halfW = canvas.width / (2 * z);
    const halfH = canvas.height / (2 * z);
    if (!m) return { x: world.width / 2 - halfW, y: world.height / 2 - halfH, z };
    return { x: m.x - halfW, y: m.y - halfH, z };
}

setInterval(() => {
    if (!ws || ws.readyState !== 1 || !me() || isDead || phase !== "playing") return;
    const cam = cameraOffset();
    send({ type: "input", x: mouse.x / cam.z + cam.x, y: mouse.y / cam.z + cam.y });
}, 33);

// ---------------- render loop ----------------
function ease(t) {
    const byId = new Map(renderSnakes.map(s => [s.id, s]));
    const next = [];
    for (const ts of targetSnakes) {
        const cs = byId.get(ts.id);
        if (!cs) {
            next.push({
                id: ts.id, name: ts.name, avatar: ts.avatar,
                color: ts.color, pattern: ts.pattern, score: ts.score,
                team: ts.team, combo: ts.combo,
                shield: ts.shield, gold: ts.gold, speed: ts.speed, magnet: ts.magnet,
                boss: ts.boss,
                x: ts.x, y: ts.y, angle: ts.angle,
                body: ts.body.map(s => ({ x: s.x, y: s.y })),
            });
            continue;
        }
        cs.x = lerp(cs.x, ts.x, t);
        cs.y = lerp(cs.y, ts.y, t);
        cs.angle = lerpAngle(cs.angle, ts.angle, t);
        while (cs.body.length < ts.body.length) {
            const tail = cs.body[cs.body.length - 1] || { x: ts.x, y: ts.y };
            cs.body.push({ x: tail.x, y: tail.y });
        }
        cs.body.length = ts.body.length;
        for (let i = 0; i < ts.body.length; i++) {
            cs.body[i].x = lerp(cs.body[i].x, ts.body[i].x, t);
            cs.body[i].y = lerp(cs.body[i].y, ts.body[i].y, t);
        }
        cs.name = ts.name; cs.avatar = ts.avatar;
        cs.color = ts.color; cs.pattern = ts.pattern;
        cs.score = ts.score; cs.team = ts.team; cs.combo = ts.combo;
        cs.shield = ts.shield; cs.gold = ts.gold;
        cs.speed = ts.speed; cs.magnet = ts.magnet;
        cs.boss = ts.boss;
        next.push(cs);
    }
    renderSnakes = next;
}

function render() {
    ease(0.3);
    ctx.fillStyle = "#161b22";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const cam = cameraOffset();
    ctx.save();
    ctx.scale(cam.z, cam.z);
    ctx.translate(-cam.x, -cam.y);

    if (safeZone) {
        // LSS: the map IS the shrinking circle. Clip every gameplay layer to it.
        ctx.save();
        ctx.beginPath();
        ctx.arc(safeZone.cx, safeZone.cy, safeZone.r, 0, Math.PI * 2);
        ctx.clip();
        // Pre-fill so drawTerrain (which clamps to the world rect) never
        // leaves the canvas background showing through inside the circle.
        ctx.fillStyle = currentTheme.base;
        ctx.fillRect(cam.x, cam.y, camWorldW(cam), camWorldH(cam));
        drawTerrain(cam);
        if (hill) drawHill();
        for (const f of foodList) drawFood(f);
        for (const s of renderSnakes) drawSnake(s, s.id === myId);
        ctx.restore();
        drawCircularWall();
    } else {
        drawTerrain(cam);
        drawAbyss(cam);
        drawStoneWall();
        if (hill) drawHill();
        for (const f of foodList) drawFood(f);
        drawObstacles();
        for (const s of renderSnakes) drawSnake(s, s.id === myId);
    }
    updateParticles();
    drawParticles(ctx);
    drawActiveEmotes();
    drawComboBadges();
    drawItMarker();
    drawBombMarker();

    ctx.restore();

    drawUrgencyVignette();
    drawDeathFlash(ctx, canvas.width, canvas.height);
    drawEffectBadges();
    drawBossBanner();
    renderLeaderboard();
    if (phase === "intermission") renderIntermission();
    updateTimerDisplay();
    requestAnimationFrame(render);
}

// Hot Potato: 💣 emoji + countdown ring above the bomb holder's head.
function drawBombMarker() {
    if (!bombHolderId) return;
    const s = renderSnakes.find(x => x.id === bombHolderId);
    if (!s) return;
    const remaining = Math.max(0, bombExpiresAt - Date.now());
    const frac = Math.min(1, remaining / 12000);
    // Pulsing speeds up as the bomb ticks down
    const pulseRate = 220 - (1 - frac) * 160;
    const pulse = 0.6 + 0.4 * Math.sin(Date.now() / pulseRate);
    // Red ring around the head
    ctx.save();
    ctx.shadowColor = '#f85149';
    ctx.shadowBlur = 18 + (1 - frac) * 14;
    ctx.strokeStyle = `rgba(248, 81, 73, ${pulse})`;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(s.x, s.y, 24, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    // 💣 above head
    ctx.font = "30px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText('💣', s.x, s.y - 48);
    // Countdown arc (shrinks as time runs out)
    ctx.save();
    ctx.strokeStyle = `rgba(255, 220, 100, ${0.85})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(s.x, s.y - 48, 18, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    // Big numeric seconds when ≤5s left
    const sec = Math.ceil(remaining / 1000);
    if (sec <= 5) {
        ctx.fillStyle = '#ffec3d';
        ctx.font = "bold 20px Arial";
        ctx.fillText(String(sec), s.x, s.y - 48);
    }
}

// Tag mode: red pulsing aura + 👹 emoji above the "it" snake's head.
function drawItMarker() {
    if (!itPlayerId) return;
    const s = renderSnakes.find(x => x.id === itPlayerId);
    if (!s) return;
    const pulse = 0.7 + 0.3 * Math.sin(Date.now() / 220);
    ctx.save();
    ctx.shadowColor = '#f85149';
    ctx.shadowBlur = 18;
    ctx.strokeStyle = `rgba(248, 81, 73, ${pulse})`;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(s.x, s.y, 22, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    ctx.font = "26px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText('👹', s.x, s.y - 42);
}

// Floating "xN COMBO!" text above snakes with an active combo level.
function drawComboBadges() {
    if (settings.reduceMotion) return;
    for (const s of renderSnakes) {
        if (!s.combo || s.combo < 2) continue;
        const isMe = s.id === myId;
        const colors = ['', '', '#f0e84a', '#f0883e', '#f85149', '#facc15'];
        const c = colors[s.combo] || '#facc15';
        const size = isMe ? 18 : 14;
        ctx.save();
        ctx.font = `bold ${size}px Arial`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.shadowColor = c;
        ctx.shadowBlur = 8;
        ctx.fillStyle = c;
        ctx.fillText(`x${s.combo} COMBO!`, s.x, s.y - 50);
        ctx.restore();
    }
}

// Floating emojis above the heads of snakes that just sent an emote.
function drawActiveEmotes() {
    const now = Date.now();
    for (const [id, e] of activeEmotes) {
        if (now > e.until) { activeEmotes.delete(id); continue; }
        const s = renderSnakes.find(x => x.id === id);
        if (!s) continue;
        const age = 1 - (e.until - now) / 2200;
        const lift = age * 28;
        const alpha = age < 0.85 ? 1 : (1 - age) / 0.15;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.font = "32px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(e.emote, s.x, s.y - 36 - lift);
        ctx.restore();
    }
}

// Dark red vignette closes in from the edges during the final 30 seconds.
function drawUrgencyVignette() {
    if (phase !== "playing" || !phaseEndsAt) return;
    if (settings.reduceMotion) return;
    const remaining = Math.max(0, phaseEndsAt - Date.now()) / 1000;
    if (remaining > 30) return;
    const intensity = Math.min(1, (30 - remaining) / 30);
    const cx = canvas.width / 2, cy = canvas.height / 2;
    const innerR = Math.min(canvas.width, canvas.height) * (0.55 - 0.15 * intensity);
    const outerR = Math.max(canvas.width, canvas.height) * 0.75;
    const g = ctx.createRadialGradient(cx, cy, innerR, cx, cy, outerR);
    g.addColorStop(0, 'rgba(80, 0, 0, 0)');
    g.addColorStop(1, `rgba(120, 0, 0, ${0.55 * intensity})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function updateTimerDisplay() {
    if (phase === "playing" && phaseEndsAt) {
        const sec = Math.max(0, Math.ceil((phaseEndsAt - Date.now()) / 1000));
        roundLabelEl.textContent = `Round ${roundNumber}`;
        if (sec <= 30 && sec > 0) {
            roundTimeEl.textContent = String(sec);
            roundTimeEl.classList.add("urgent");
        } else {
            const m = Math.floor(sec / 60);
            const s = sec % 60;
            roundTimeEl.textContent = `${m}:${String(s).padStart(2, "0")}`;
            roundTimeEl.classList.remove("urgent");
        }
        if (sec <= 5 && sec > 0 && sec !== updateTimerDisplay._lastTick) {
            updateTimerDisplay._lastTick = sec;
            sndCountdown();
        }
    } else if (phase === "intermission") {
        const sec = Math.max(0, Math.ceil((phaseEndsAt - Date.now()) / 1000));
        roundLabelEl.textContent = "Intermission";
        roundTimeEl.textContent = `${sec}s`;
        roundTimeEl.classList.remove("urgent");
        updateTimerDisplay._lastTick = null;
    } else {
        roundLabelEl.textContent = "—";
        roundTimeEl.textContent = "—";
        roundTimeEl.classList.remove("urgent");
        updateTimerDisplay._lastTick = null;
    }
    if (meEliminated && phase === "playing" && spectatingId != null) {
        const target = renderSnakes.find(s => s.id === spectatingId);
        spectatorNameEl.textContent = target ? (target.name || "anon") : "—";
        spectatorOverlayEl.style.display = "";
    } else {
        spectatorOverlayEl.style.display = "none";
    }
}

// Boss Snake HUD: a banner across the top of the screen telling players
// who they're fighting and how long the boss currently is.
function drawBossBanner() {
    if (phase !== "playing") return;
    const boss = renderSnakes.find(s => s.boss);
    if (!boss) return;
    const w = 320;
    const h = 38;
    const x = (canvas.width - w) / 2;
    const y = 16;
    ctx.save();
    // Red gradient backdrop with dragon glyph
    const grad = ctx.createLinearGradient(x, 0, x + w, 0);
    grad.addColorStop(0, 'rgba(80, 8, 12, 0.92)');
    grad.addColorStop(0.5, 'rgba(160, 22, 22, 0.92)');
    grad.addColorStop(1, 'rgba(80, 8, 12, 0.92)');
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#ffec3d';
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    // Text
    ctx.fillStyle = '#ffec3d';
    ctx.font = 'bold 18px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`🐲  BOSS  —  ${boss.body.length} segments`, x + w / 2, y + h / 2 + 1);
    ctx.restore();
}

function drawEffectBadges() {
    if (phase !== "playing" || !myEffects) return;
    const items = [
        { key: 'goldRemain',   total: 10000, label: '★', color: '#facc15' },
        { key: 'shieldRemain', total: 6000,  label: '✦', color: '#58a6ff' },
        { key: 'speedRemain',  total: 5000,  label: '⚡', color: '#f0e84a' },
        { key: 'magnetRemain', total: 8000,  label: '⌬', color: '#c084fc' },
    ].filter(it => myEffects[it.key] > 0);
    if (!items.length) return;

    const x0 = canvas.width - 170;
    let y = 220;
    for (const it of items) {
        ctx.fillStyle = "rgba(13,17,23,0.85)";
        ctx.fillRect(x0, y, 158, 30);
        ctx.strokeStyle = it.color;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x0 + 0.5, y + 0.5, 157, 29);
        ctx.fillStyle = it.color;
        ctx.font = "bold 18px Arial";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(it.label, x0 + 8, y + 15);
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 12px Arial";
        ctx.fillText(`${(myEffects[it.key] / 1000).toFixed(1)}s`, x0 + 30, y + 15);
        const w = 110 * (myEffects[it.key] / it.total);
        ctx.fillStyle = it.color;
        ctx.fillRect(x0 + 70, y + 22, w, 4);
        y += 36;
    }
    ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
}

// ---------- Terrain dispatcher ----------
function drawTerrain(cam) {
    switch (currentThemeId) {
        case 'desert': drawDesertTerrain(cam); break;
        case 'snow':   drawSnowTerrain(cam); break;
        case 'lava':   drawLavaTerrain(cam); break;
        default:       drawGrasslandsTerrain(cam);
    }
}

// ---------- Shared terrain helpers ----------
// Visible world width/height depends on zoom (camera.z): with z=0.5 we see 2× the
// canvas in world coords.
function camWorldW(cam) { return canvas.width  / (cam.z || 1); }
function camWorldH(cam) { return canvas.height / (cam.z || 1); }

function fillBase(cam, color) {
    const x0 = Math.max(0, cam.x);
    const y0 = Math.max(0, cam.y);
    const x1 = Math.min(world.width,  cam.x + camWorldW(cam));
    const y1 = Math.min(world.height, cam.y + camWorldH(cam));
    if (x1 <= x0 || y1 <= y0) return false;
    ctx.fillStyle = color;
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    return true;
}
// Per-cell color patch overlay. Instead of solid rects (which read as a
// visible tile grid), draw each patch as a jittered, rotated, oblong ellipse
// — overlapping neighbors break up the alignment and the terrain looks
// organic rather than gridded.
function patchOverlay(cam, patch, colorPicker) {
    const psx = Math.max(0, Math.floor(cam.x / patch) * patch);
    const psy = Math.max(0, Math.floor(cam.y / patch) * patch);
    const pex = Math.min(world.width,  cam.x + camWorldW(cam) + patch);
    const pey = Math.min(world.height, cam.y + camWorldH(cam) + patch);
    for (let py = psy; py < pey; py += patch) {
        for (let px = psx; px < pex; px += patch) {
            const c = colorPicker(noise2d(px * 0.018, py * 0.018));
            if (!c) continue;
            const h = hash(px, py);
            const jx = ((h & 0xff) / 255 - 0.5) * patch * 0.8;
            const jy = (((h >>> 8) & 0xff) / 255 - 0.5) * patch * 0.8;
            const rot = ((h >>> 16) & 0xff) / 255 * Math.PI;
            const rx = patch * (0.7 + ((h >>> 4)  & 0x3f) / 63 * 0.55);
            const ry = patch * (0.45 + ((h >>> 24) & 0x3f) / 63 * 0.45);
            ctx.fillStyle = c;
            ctx.beginPath();
            ctx.ellipse(px + patch / 2 + jx, py + patch / 2 + jy, rx, ry, rot, 0, Math.PI * 2);
            ctx.fill();
        }
    }
}

// Soft directional "sun" lighting anchored to world coordinates — same
// gradient angle everywhere, so as the camera pans the lit/shadow sides of
// the map stay consistent. Sells the 2.5D impression without affecting
// gameplay clarity.
function applyTerrainLighting(cam, lightAlpha = 0.10, shadowAlpha = 0.22) {
    const x0 = Math.max(0, cam.x);
    const y0 = Math.max(0, cam.y);
    const x1 = Math.min(world.width,  cam.x + camWorldW(cam));
    const y1 = Math.min(world.height, cam.y + camWorldH(cam));
    if (x1 <= x0 || y1 <= y0) return;
    const g = ctx.createLinearGradient(0, 0, world.width, world.height);
    g.addColorStop(0, `rgba(255, 240, 200, ${lightAlpha})`);
    g.addColorStop(0.5, 'rgba(0, 0, 0, 0)');
    g.addColorStop(1, `rgba(0, 0, 30, ${shadowAlpha})`);
    ctx.fillStyle = g;
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
}
function forEachCell(cam, cell, callback) {
    const sx = Math.max(0, Math.floor(cam.x / cell) * cell);
    const sy = Math.max(0, Math.floor(cam.y / cell) * cell);
    const ex = Math.min(world.width,  cam.x + camWorldW(cam) + cell);
    const ey = Math.min(world.height, cam.y + camWorldH(cam) + cell);
    for (let cy = sy; cy < ey; cy += cell) {
        for (let cx = sx; cx < ex; cx += cell) {
            callback(cx, cy, hash(cx, cy));
        }
    }
}

// ---------- Theme 1: GRASSLANDS ----------
function drawGrasslandsTerrain(cam) {
    if (!fillBase(cam, currentTheme.base)) return;
    patchOverlay(cam, 36, n => {
        if (n < 0.30) return currentTheme.patchDark;
        if (n > 0.82) return currentTheme.patchBright;
        if (n > 0.65) return currentTheme.patchLight;
        return null;
    });
    applyTerrainLighting(cam);
    const cell = 28;
    const blades = [], clumps = [], flowers = [], pebbles = [], dirts = [];
    forEachCell(cam, cell, (cx, cy, h) => {
        const kind = h & 0xff;
        const px = cx + (((h >>> 8) & 0xff) / 255) * cell;
        const py = cy + (((h >>> 16) & 0xff) / 255) * cell;
        const bladeCount = 1 + Math.floor(noise2d(cx * 0.02, cy * 0.02) * 4);
        for (let b = 0; b < bladeCount; b++) {
            const hb = hash(cx + b * 17, cy + b * 23);
            blades.push(cx + ((hb & 0xff) / 255) * cell, cy + (((hb >>> 8) & 0xff) / 255) * cell, hb);
        }
        if      (kind < 18) dirts.push(px, py, h);
        else if (kind < 32) pebbles.push(px, py, h);
        else if (kind < 52) flowers.push(px, py, h);
        else if (kind < 96) clumps.push(px, py, h);
    });
    drawGrassDirts(dirts);
    drawGrassClumps(clumps);
    drawPebbles(pebbles, currentTheme.pebbleBase);
    drawGrassBlades(blades);
    drawGrassFlowers(flowers);
}

function drawGrassBlades(arr) {
    ctx.lineCap = "round";
    ctx.strokeStyle = currentTheme.bladeDark; ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let i = 0; i < arr.length; i += 3) {
        const x = arr[i], y = arr[i + 1], h = arr[i + 2];
        const len = 3 + ((h >>> 8) & 0x3);
        const lean = (((h >>> 12) & 0xf) / 15 - 0.5) * 3;
        ctx.moveTo(x, y);
        ctx.quadraticCurveTo(x + lean / 2, y - len / 2, x + lean, y - len);
    }
    ctx.stroke();
    ctx.strokeStyle = currentTheme.bladeLight; ctx.lineWidth = 0.8;
    ctx.beginPath();
    for (let i = 0; i < arr.length; i += 3) {
        const x = arr[i], y = arr[i + 1], h = arr[i + 2];
        const len = 2 + ((h >>> 8) & 0x3);
        const lean = (((h >>> 12) & 0xf) / 15 - 0.5) * 3;
        const offX = (((h >>> 16) & 0xf) / 15 - 0.5) * 1.5;
        ctx.moveTo(x + offX, y);
        ctx.quadraticCurveTo(x + offX + lean / 2, y - len / 2, x + offX + lean, y - len);
    }
    ctx.stroke();
}
function drawGrassClumps(arr) {
    ctx.fillStyle = currentTheme.clumpShadow;
    for (let i = 0; i < arr.length; i += 3) {
        ctx.beginPath();
        ctx.ellipse(arr[i], arr[i + 1] + 1, 5, 2, 0, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.lineCap = "round";
    ctx.strokeStyle = currentTheme.clumpDark; ctx.lineWidth = 1.8;
    ctx.beginPath();
    for (let i = 0; i < arr.length; i += 3) {
        const x = arr[i], y = arr[i + 1], h = arr[i + 2];
        const n = 4 + (h & 3);
        for (let j = 0; j < n; j++) {
            const hj = hash(x + j * 7, y + j * 11);
            const dx = ((hj & 0xf) / 15 - 0.5) * 6;
            const len = 6 + ((hj >>> 4) & 5);
            const lean = (((hj >>> 8) & 0xf) / 15 - 0.5) * 5;
            ctx.moveTo(x + dx, y);
            ctx.quadraticCurveTo(x + dx + lean / 2, y - len / 2, x + dx + lean, y - len);
        }
    }
    ctx.stroke();
    ctx.strokeStyle = currentTheme.clumpLight; ctx.lineWidth = 1.1;
    ctx.beginPath();
    for (let i = 0; i < arr.length; i += 3) {
        const x = arr[i], y = arr[i + 1], h = arr[i + 2];
        const n = 3 + ((h >>> 4) & 2);
        for (let j = 0; j < n; j++) {
            const hj = hash(x + j * 13, y + j * 5);
            const dx = ((hj & 0xf) / 15 - 0.5) * 5;
            const len = 5 + ((hj >>> 4) & 4);
            const lean = (((hj >>> 8) & 0xf) / 15 - 0.5) * 4;
            ctx.moveTo(x + dx, y);
            ctx.quadraticCurveTo(x + dx + lean / 2, y - len / 2, x + dx + lean, y - len);
        }
    }
    ctx.stroke();
}
function drawGrassFlowers(arr) {
    const palettes = [
        ["#f4f7fa", "#f4d03f"], ["#f4d03f", "#946d0e"],
        ["#d9b3ff", "#7d3c98"], ["#ff8a8a", "#a02020"],
        ["#a5d8ff", "#3f6caa"],
    ];
    for (let i = 0; i < arr.length; i += 3) {
        const x = arr[i], y = arr[i + 1], h = arr[i + 2];
        const p = palettes[(h >>> 24) % palettes.length];
        ctx.fillStyle = "rgba(0,0,0,0.18)";
        ctx.beginPath(); ctx.ellipse(x, y + 0.5, 3.5, 1.4, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = p[0];
        ctx.beginPath(); ctx.arc(x, y, 2.6, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = p[1];
        ctx.beginPath(); ctx.arc(x, y, 1, 0, Math.PI * 2); ctx.fill();
    }
}
function drawGrassDirts(arr) {
    for (let i = 0; i < arr.length; i += 3) {
        const x = arr[i], y = arr[i + 1], h = arr[i + 2];
        const r = 5 + ((h >>> 24) & 3);
        ctx.fillStyle = "rgba(96, 64, 38, 0.55)";
        ctx.beginPath(); ctx.ellipse(x, y, r * 1.6, r * 1.1, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "rgba(60, 38, 22, 0.7)";
        for (let j = 0; j < 3; j++) {
            const hj = hash(x + j * 11, y + j * 13);
            const ox = ((hj & 0xff) / 255 - 0.5) * r * 1.5;
            const oy = (((hj >>> 8) & 0xff) / 255 - 0.5) * r * 0.8;
            ctx.beginPath(); ctx.arc(x + ox, y + oy, 1, 0, Math.PI * 2); ctx.fill();
        }
    }
}

// shared pebble (used by grasslands + snow + desert variants)
function drawPebbles(arr, base, hueRG = [-3, -8]) {
    for (let i = 0; i < arr.length; i += 3) {
        const x = arr[i], y = arr[i + 1], h = arr[i + 2];
        const r = 1.8 + ((h >>> 24) & 3) * 0.4;
        const g = base + ((h >>> 4) & 0x1f);
        ctx.fillStyle = "rgba(0,0,0,0.25)";
        ctx.beginPath(); ctx.ellipse(x, y + 1, r * 1.3, r * 0.6, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = `rgb(${g}, ${g + hueRG[0]}, ${g + hueRG[1]})`;
        ctx.beginPath(); ctx.ellipse(x, y, r * 1.2, r * 0.8, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.18)";
        ctx.beginPath(); ctx.ellipse(x - r * 0.3, y - r * 0.25, r * 0.5, r * 0.3, 0, 0, Math.PI * 2); ctx.fill();
    }
}

// ---------- Theme 2: DESERT ----------
function drawDesertTerrain(cam) {
    if (!fillBase(cam, currentTheme.base)) return;
    patchOverlay(cam, 42, n => {
        if (n < 0.32) return currentTheme.patchDark;
        if (n > 0.78) return currentTheme.patchBright;
        if (n > 0.62) return currentTheme.patchLight;
        return null;
    });
    // Warmer sunlight + stronger shadow for the desert dune look
    applyTerrainLighting(cam, 0.18, 0.30);
    drawSandRipples(cam);

    const cell = 36;
    const cacti = [], bushes = [], rocks = [], sands = [];
    forEachCell(cam, cell, (cx, cy, h) => {
        const kind = h & 0xff;
        const px = cx + (((h >>> 8) & 0xff) / 255) * cell;
        const py = cy + (((h >>> 16) & 0xff) / 255) * cell;
        if      (kind < 18) sands.push(px, py, h);
        else if (kind < 56) rocks.push(px, py, h);
        else if (kind < 86) bushes.push(px, py, h);
        else if (kind < 110) cacti.push(px, py, h);
    });
    drawSandPatches(sands);
    drawDesertRocks(rocks);
    drawCacti(cacti);
    drawDriedBushes(bushes);
}

function drawSandRipples(cam) {
    const cell = 70;
    ctx.strokeStyle = "rgba(120, 95, 55, 0.35)";
    ctx.lineWidth = 1.4;
    ctx.lineCap = "round";
    ctx.beginPath();
    forEachCell(cam, cell, (cx, cy, h) => {
        const ox = ((h & 0xff) / 255) * cell;
        const oy = (((h >>> 8) & 0xff) / 255) * cell;
        const len = 28 + ((h >>> 12) & 0xf);
        const x = cx + ox, y = cy + oy;
        const rot = (((h >>> 16) & 0xff) / 255 - 0.5) * 0.4;
        ctx.moveTo(x - len / 2, y);
        ctx.quadraticCurveTo(x, y - 4 + rot * 6, x + len / 2, y);
    });
    ctx.stroke();
}
function drawSandPatches(arr) {
    for (let i = 0; i < arr.length; i += 3) {
        const x = arr[i], y = arr[i + 1], h = arr[i + 2];
        const r = 6 + ((h >>> 24) & 3);
        ctx.fillStyle = "rgba(150, 120, 75, 0.4)";
        ctx.beginPath(); ctx.ellipse(x, y, r * 1.8, r * 1.0, 0, 0, Math.PI * 2); ctx.fill();
    }
}
function drawCacti(arr) {
    for (let i = 0; i < arr.length; i += 3) {
        const x = arr[i], y = arr[i + 1], h = arr[i + 2];
        const tall = 14 + ((h >>> 4) & 0x7);
        ctx.fillStyle = "rgba(0,0,0,0.28)";
        ctx.beginPath(); ctx.ellipse(x + 2, y + 1, 7, 2.4, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#2a5328";
        ctx.fillRect(x - 4, y - tall, 8, tall);
        ctx.beginPath(); ctx.arc(x, y - tall, 4, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#3a6b3a";
        ctx.fillRect(x - 3, y - tall, 6, tall);
        ctx.beginPath(); ctx.arc(x, y - tall, 3, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = "#2c5b2e"; ctx.lineWidth = 0.6;
        ctx.beginPath();
        ctx.moveTo(x - 1, y - tall + 1); ctx.lineTo(x - 1, y - 2);
        ctx.moveTo(x + 1, y - tall + 1); ctx.lineTo(x + 1, y - 2);
        ctx.stroke();
        if ((h >>> 8) & 1) {
            const side = ((h >>> 9) & 1) ? -1 : 1;
            const armY = y - tall * 0.55;
            ctx.fillStyle = "#3a6b3a";
            ctx.fillRect(x + side * 3, armY, side * 5, 4);
            ctx.fillRect(x + side * 7, armY - 5, 4, 6);
            ctx.beginPath(); ctx.arc(x + side * 9, armY - 5, 2, 0, Math.PI * 2); ctx.fill();
        }
    }
}
function drawDriedBushes(arr) {
    ctx.strokeStyle = "#6a4a25";
    ctx.lineWidth = 1.0;
    ctx.lineCap = "round";
    ctx.beginPath();
    for (let i = 0; i < arr.length; i += 3) {
        const x = arr[i], y = arr[i + 1], h = arr[i + 2];
        for (let j = 0; j < 7; j++) {
            const ang = (j / 7) * Math.PI * 2 + (((h >>> j) & 1) ? 0.3 : 0);
            const r = 3 + ((h >>> (j * 2)) & 3);
            ctx.moveTo(x, y);
            ctx.lineTo(x + Math.cos(ang) * r, y + Math.sin(ang) * r);
        }
    }
    ctx.stroke();
    ctx.fillStyle = "rgba(60,40,20,0.7)";
    for (let i = 0; i < arr.length; i += 3) {
        ctx.beginPath(); ctx.arc(arr[i], arr[i + 1], 0.8, 0, Math.PI * 2); ctx.fill();
    }
}
function drawDesertRocks(arr) {
    for (let i = 0; i < arr.length; i += 3) {
        const x = arr[i], y = arr[i + 1], h = arr[i + 2];
        const r = 2.6 + ((h >>> 24) & 3) * 0.7;
        ctx.fillStyle = "rgba(0,0,0,0.3)";
        ctx.beginPath(); ctx.ellipse(x + 1, y + 2, r * 1.5, r * 0.7, 0, 0, Math.PI * 2); ctx.fill();
        const g = 160 + ((h >>> 4) & 0x1f);
        ctx.fillStyle = `rgb(${g}, ${g - 25}, ${g - 55})`;
        ctx.beginPath(); ctx.ellipse(x, y, r * 1.3, r * 0.9, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "rgba(255,240,200,0.25)";
        ctx.beginPath(); ctx.ellipse(x - r * 0.3, y - r * 0.3, r * 0.5, r * 0.3, 0, 0, Math.PI * 2); ctx.fill();
    }
}

// ---------- Theme 3: SNOW ----------
function drawSnowTerrain(cam) {
    if (!fillBase(cam, currentTheme.base)) return;
    patchOverlay(cam, 44, n => {
        if (n < 0.30) return currentTheme.patchDark;
        if (n > 0.80) return currentTheme.patchBright;
        if (n > 0.60) return currentTheme.patchLight;
        return null;
    });
    // Cool blue shadow side, soft warm sunlight on the lit side
    applyTerrainLighting(cam, 0.10, 0.18);

    const cell = 32;
    const drifts = [], flakes = [], rocks = [], sparkles = [];
    forEachCell(cam, cell, (cx, cy, h) => {
        const kind = h & 0xff;
        const px = cx + (((h >>> 8) & 0xff) / 255) * cell;
        const py = cy + (((h >>> 16) & 0xff) / 255) * cell;
        const sparkN = 1 + ((h >>> 24) & 1);
        for (let b = 0; b < sparkN; b++) {
            const hb = hash(cx + b * 17, cy + b * 23);
            sparkles.push(cx + ((hb & 0xff) / 255) * cell, cy + (((hb >>> 8) & 0xff) / 255) * cell);
        }
        if      (kind < 22) rocks.push(px, py, h);
        else if (kind < 56) drifts.push(px, py, h);
        else if (kind < 96) flakes.push(px, py, h);
    });
    drawSnowDrifts(drifts);
    drawFrozenRocks(rocks);
    drawSnowflakes(flakes);
    drawSparkles(sparkles);
}
function drawSnowDrifts(arr) {
    ctx.fillStyle = "rgba(100,130,180,0.18)";
    for (let i = 0; i < arr.length; i += 3) {
        const x = arr[i], y = arr[i + 1], h = arr[i + 2];
        const w = 14 + ((h >>> 4) & 0x7);
        ctx.beginPath(); ctx.ellipse(x, y + 2, w * 0.9, 3, 0, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = "#ffffff";
    for (let i = 0; i < arr.length; i += 3) {
        const x = arr[i], y = arr[i + 1], h = arr[i + 2];
        const w = 14 + ((h >>> 4) & 0x7);
        ctx.beginPath();
        ctx.ellipse(x, y, w, 5, 0, Math.PI, Math.PI * 2);
        ctx.lineTo(x - w, y);
        ctx.closePath();
        ctx.fill();
    }
    ctx.fillStyle = "rgba(180,200,225,0.45)";
    for (let i = 0; i < arr.length; i += 3) {
        const x = arr[i], y = arr[i + 1], h = arr[i + 2];
        const w = 14 + ((h >>> 4) & 0x7);
        ctx.beginPath();
        ctx.ellipse(x, y - 0.5, w * 0.8, 1.5, 0, 0, Math.PI);
        ctx.fill();
    }
}
function drawSnowflakes(arr) {
    ctx.strokeStyle = "#dde9f5"; ctx.lineWidth = 0.8;
    ctx.lineCap = "round";
    ctx.beginPath();
    for (let i = 0; i < arr.length; i += 3) {
        const x = arr[i], y = arr[i + 1], h = arr[i + 2];
        const r = 1.8 + ((h >>> 4) & 1);
        for (let k = 0; k < 6; k++) {
            const ang = (k / 6) * Math.PI * 2;
            ctx.moveTo(x, y);
            ctx.lineTo(x + Math.cos(ang) * r, y + Math.sin(ang) * r);
        }
    }
    ctx.stroke();
}
function drawSparkles(arr) {
    ctx.fillStyle = "rgba(255,255,255,0.65)";
    for (let i = 0; i < arr.length; i += 2) {
        ctx.fillRect(arr[i], arr[i + 1], 1, 1);
    }
}
function drawFrozenRocks(arr) {
    for (let i = 0; i < arr.length; i += 3) {
        const x = arr[i], y = arr[i + 1], h = arr[i + 2];
        const r = 3 + ((h >>> 24) & 3) * 0.5;
        ctx.fillStyle = "rgba(70,100,140,0.25)";
        ctx.beginPath(); ctx.ellipse(x + 1, y + 2, r * 1.4, r * 0.6, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#5a6b80";
        ctx.beginPath(); ctx.ellipse(x, y, r * 1.3, r * 0.9, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.ellipse(x, y - r * 0.35, r * 1.0, r * 0.32, 0, Math.PI, Math.PI * 2);
        ctx.closePath();
        ctx.fill();
    }
}

// ---------- Theme 4: LAVA ----------
function drawLavaTerrain(cam) {
    if (!fillBase(cam, currentTheme.base)) return;
    patchOverlay(cam, 40, n => {
        if (n < 0.30) return currentTheme.patchDark;
        if (n > 0.80) return currentTheme.patchBright;
        if (n > 0.62) return currentTheme.patchLight;
        return null;
    });
    // Lava: ember glow from upper-left, deep shadow elsewhere
    applyTerrainLighting(cam, 0.20, 0.45);

    const cell = 34;
    const pools = [], cracks = [], obsidian = [], embers = [];
    forEachCell(cam, cell, (cx, cy, h) => {
        const kind = h & 0xff;
        const px = cx + (((h >>> 8) & 0xff) / 255) * cell;
        const py = cy + (((h >>> 16) & 0xff) / 255) * cell;
        if      (kind < 10) pools.push(px, py, h);
        else if (kind < 40) cracks.push(px, py, h);
        else if (kind < 75) obsidian.push(px, py, h);
        else if (kind < 130) embers.push(px, py, h);
    });
    drawLavaPools(pools);
    drawLavaCracks(cracks);
    drawObsidianShards(obsidian);
    drawEmbers(embers);
}
function drawLavaPools(arr) {
    for (let i = 0; i < arr.length; i += 3) {
        const x = arr[i], y = arr[i + 1], h = arr[i + 2];
        const r = 8 + ((h >>> 24) & 7);
        ctx.fillStyle = "rgba(255,100,40,0.18)";
        ctx.beginPath(); ctx.ellipse(x, y, r * 1.9, r * 1.3, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#cd3a1a";
        ctx.beginPath(); ctx.ellipse(x, y, r * 1.2, r * 0.9, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#ffb84a";
        ctx.beginPath(); ctx.ellipse(x, y, r * 0.55, r * 0.4, 0, 0, Math.PI * 2); ctx.fill();
    }
}
function drawLavaCracks(arr) {
    ctx.strokeStyle = "#e84a1a";
    ctx.lineWidth = 1.4;
    ctx.lineCap = "round";
    ctx.shadowColor = "#ff6020";
    ctx.shadowBlur = 5;
    ctx.beginPath();
    for (let i = 0; i < arr.length; i += 3) {
        const x = arr[i], y = arr[i + 1], h = arr[i + 2];
        const segs = 3 + (h & 1);
        let px = x, py = y;
        ctx.moveTo(px, py);
        for (let j = 0; j < segs; j++) {
            const hj = hash(x + j * 7, y + j * 11);
            const dx = ((hj & 0xff) / 255 - 0.5) * 9;
            const dy = ((hj >>> 8) & 0xff) / 255 * 6;
            px += dx; py += dy;
            ctx.lineTo(px, py);
        }
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
}
function drawObsidianShards(arr) {
    for (let i = 0; i < arr.length; i += 3) {
        const x = arr[i], y = arr[i + 1], h = arr[i + 2];
        const r = 3 + ((h >>> 24) & 3);
        ctx.fillStyle = "rgba(0,0,0,0.4)";
        ctx.beginPath(); ctx.ellipse(x + 1, y + 2, r * 1.4, r * 0.6, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#15080a";
        ctx.beginPath();
        ctx.moveTo(x, y - r);
        ctx.lineTo(x + r, y - r * 0.2);
        ctx.lineTo(x + r * 0.5, y + r * 0.8);
        ctx.lineTo(x - r * 0.8, y + r * 0.4);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = "rgba(220,80,40,0.55)";
        ctx.lineWidth = 0.6;
        ctx.stroke();
    }
}
function drawEmbers(arr) {
    ctx.fillStyle = "rgba(255,150,60,0.45)";
    for (let i = 0; i < arr.length; i += 3) {
        const x = arr[i], y = arr[i + 1], h = arr[i + 2];
        const r = 0.9 + ((h >>> 4) & 1) * 0.6;
        ctx.beginPath(); ctx.arc(x, y, r * 3, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = "#ffd680";
    for (let i = 0; i < arr.length; i += 3) {
        const x = arr[i], y = arr[i + 1], h = arr[i + 2];
        const r = 0.9 + ((h >>> 4) & 1) * 0.6;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
}

// Everything outside the world rect is the abyss — deep blue-black void with
// faint twinkling stars. Called between drawTerrain and drawStoneWall so the
// wall band always sits on top.
function drawAbyss(cam) {
    const W = world.width, H = world.height;
    const vw = camWorldW(cam);
    const vh = camWorldH(cam);
    const vx0 = cam.x, vy0 = cam.y;
    const vx1 = cam.x + vw, vy1 = cam.y + vh;
    // Bail when the view is entirely inside the play field — no abyss visible.
    if (vx0 >= 0 && vy0 >= 0 && vx1 <= W && vy1 <= H) return;

    // 1. Deep void fill via evenodd cutout — paint everywhere visible OUTSIDE
    //    the world rect, leaving the play field interior untouched.
    ctx.save();
    ctx.fillStyle = '#02040a';
    ctx.beginPath();
    ctx.rect(vx0 - 20, vy0 - 20, vw + 40, vh + 40);
    ctx.rect(0, 0, W, H);
    ctx.fill('evenodd');
    ctx.restore();

    // 2. Deterministic twinkling stars in the visible abyss. Each cell rolls
    //    a hash; ~half get a star, 1-in-16 of those are bright.
    const cell = 56;
    const sx0 = Math.floor(vx0 / cell) * cell;
    const sy0 = Math.floor(vy0 / cell) * cell;
    const sx1 = Math.ceil(vx1 / cell) * cell;
    const sy1 = Math.ceil(vy1 / cell) * cell;
    const now = Date.now();
    for (let cy = sy0; cy < sy1; cy += cell) {
        for (let cx = sx0; cx < sx1; cx += cell) {
            // Skip cells fully inside the play field
            if (cx >= 0 && cy >= 0 && cx + cell <= W && cy + cell <= H) continue;
            const h = hash(cx, cy);
            if ((h & 0xff) > 120) continue;
            const px = cx + ((h >>> 8) & 0xff) / 255 * cell;
            const py = cy + ((h >>> 16) & 0xff) / 255 * cell;
            // Skip individual stars that landed inside the world rect
            if (px > 0 && px < W && py > 0 && py < H) continue;
            const big = (h & 0xf00) === 0;
            const baseAlpha = big ? 0.85 : 0.4;
            const r = big ? 1.5 : 0.7;
            const twinkle = 0.5 + 0.5 * Math.sin(now / (600 + (h & 0x3f) * 18) + h);
            ctx.fillStyle = `rgba(200, 220, 255, ${baseAlpha * twinkle})`;
            ctx.beginPath();
            ctx.arc(px, py, r, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    // 3. Soft outward fade right at the world edge — the abyss "drops off"
    //    from the wall lip instead of being a hard color change.
    const FOG = 30;
    let g;
    if (vy0 < 0) {
        g = ctx.createLinearGradient(0, 0, 0, -FOG);
        g.addColorStop(0, 'rgba(0,0,0,0.55)'); g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(Math.max(vx0, -FOG), -FOG, Math.min(vw, W + 2 * FOG), FOG);
    }
    if (vy1 > H) {
        g = ctx.createLinearGradient(0, H, 0, H + FOG);
        g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.55)');
        ctx.fillStyle = g;
        ctx.fillRect(Math.max(vx0, -FOG), H, Math.min(vw, W + 2 * FOG), FOG);
    }
    if (vx0 < 0) {
        g = ctx.createLinearGradient(0, 0, -FOG, 0);
        g.addColorStop(0, 'rgba(0,0,0,0.55)'); g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(-FOG, Math.max(vy0, -FOG), FOG, Math.min(vh, H + 2 * FOG));
    }
    if (vx1 > W) {
        g = ctx.createLinearGradient(W, 0, W + FOG, 0);
        g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.55)');
        ctx.fillStyle = g;
        ctx.fillRect(W, Math.max(vy0, -FOG), FOG, Math.min(vh, H + 2 * FOG));
    }
}

function drawStoneWall() {
    const W = world.width, H = world.height, T = 28;
    drawWallBand(-T, -T, W + 2 * T, T);
    drawWallBand(-T,  H, W + 2 * T, T);
    drawWallBand(-T,  0, T, H);
    drawWallBand( W,  0, T, H);
    // Inner drop shadow — the wall casts depth into the play field
    const SHADOW = 18;
    let g = ctx.createLinearGradient(0, 0, 0, SHADOW);
    g.addColorStop(0, 'rgba(0,0,0,0.45)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, SHADOW);
    g = ctx.createLinearGradient(0, H - SHADOW, 0, H);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.45)');
    ctx.fillStyle = g; ctx.fillRect(0, H - SHADOW, W, SHADOW);
    g = ctx.createLinearGradient(0, 0, SHADOW, 0);
    g.addColorStop(0, 'rgba(0,0,0,0.45)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, SHADOW, H);
    g = ctx.createLinearGradient(W - SHADOW, 0, W, 0);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.45)');
    ctx.fillStyle = g; ctx.fillRect(W - SHADOW, 0, SHADOW, H);
}
function drawWallBand(x, y, w, h) {
    ctx.fillStyle = "#1f1f22";
    ctx.fillRect(x, y, w, h);
    const bw = 56, bh = 14, gap = 2;
    const rows = Math.ceil(h / bh) + 1;
    const cols = Math.ceil(w / bw) + 2;
    for (let r = 0; r < rows; r++) {
        const by = y + r * bh;
        if (by >= y + h) break;
        const offset = (r % 2) * (bw / 2);
        for (let c = 0; c < cols; c++) {
            const bx = x + c * bw - offset;
            if (bx + bw <= x || bx >= x + w) continue;
            const left = Math.max(bx, x);
            const right = Math.min(bx + bw, x + w);
            const top = Math.max(by, y);
            const bot = Math.min(by + bh, y + h);
            const shadeAmt = hash(Math.floor(bx), Math.floor(by)) & 0x1f;
            const g = 70 + shadeAmt;
            ctx.fillStyle = `rgb(${g},${g},${g + 4})`;
            ctx.fillRect(left + gap / 2, top + gap / 2, right - left - gap, bot - top - gap);
        }
    }
    ctx.strokeStyle = "#8b949e"; ctx.lineWidth = 1;
    ctx.beginPath();
    if (w > h) {
        const edgeY = (y < 0) ? y + h : y;
        ctx.moveTo(x, edgeY); ctx.lineTo(x + w, edgeY);
    } else {
        const edgeX = (x < 0) ? x + w : x;
        ctx.moveTo(edgeX, y); ctx.lineTo(edgeX, y + h);
    }
    ctx.stroke();
}

function powerupColor(type) {
    switch (type) {
        case 'gold':   return '#facc15';
        case 'shield': return '#58a6ff';
        case 'speed':  return '#f0e84a';
        case 'magnet': return '#c084fc';
        default:       return '#ff7b72';
    }
}
function powerupGlyph(type) {
    switch (type) {
        case 'gold':   return '★';
        case 'shield': return '✦';
        case 'speed':  return '⚡';
        case 'magnet': return '⌬';
        default:       return '';
    }
}

function drawFood(f) {
    const type = f.type || 'regular';
    if (type === 'coin') {
        // Gold Rush coin — bigger, brighter, dollar-sign glyph
        const pulse = 0.9 + 0.1 * Math.sin(Date.now() / 220 + f.id);
        const r = 9 * pulse;
        // Ground shadow
        ctx.fillStyle = 'rgba(0,0,0,0.42)';
        ctx.beginPath();
        ctx.ellipse(f.x + 2, f.y + 6, r * 1.05, r * 0.4, 0, 0, Math.PI * 2);
        ctx.fill();
        // Gold sphere with hot specular
        ctx.save();
        ctx.shadowColor = '#fde047';
        ctx.shadowBlur = 14;
        const grad = ctx.createRadialGradient(f.x - r * 0.4, f.y - r * 0.4, 0.5, f.x, f.y, r);
        grad.addColorStop(0,    '#fff7c2');
        grad.addColorStop(0.4,  '#facc15');
        grad.addColorStop(1,    '#a16207');
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.arc(f.x, f.y, r, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
        // $ glyph
        ctx.fillStyle = '#5b3a00';
        ctx.font = `bold ${Math.round(r * 1.4)}px Arial`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('$', f.x, f.y + 1);
        return;
    }
    if (type === 'regular') {
        const r = 6;
        // Drop shadow on the ground, offset down-right
        ctx.fillStyle = 'rgba(0,0,0,0.38)';
        ctx.beginPath();
        ctx.ellipse(f.x + 1, f.y + 4, r * 1.05, r * 0.45, 0, 0, Math.PI * 2);
        ctx.fill();
        // 3D sphere: radial gradient from upper-left highlight to dark rim
        const grad = ctx.createRadialGradient(f.x - r * 0.4, f.y - r * 0.4, 0.5, f.x, f.y, r);
        grad.addColorStop(0,    '#ffffff');
        grad.addColorStop(0.28, f.color);
        grad.addColorStop(1,    shade(f.color, -45));
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(f.x, f.y, r, 0, Math.PI * 2);
        ctx.fill();
        // Tiny specular dot
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.beginPath();
        ctx.arc(f.x - r * 0.42, f.y - r * 0.42, r * 0.22, 0, Math.PI * 2);
        ctx.fill();
        return;
    }
    // Power-up: same sphere treatment + colored aura + glyph
    const c = powerupColor(type);
    const pulse = 0.85 + 0.15 * Math.sin(Date.now() / 200 + f.id);
    const r = 11 * pulse;
    // Ground shadow
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.beginPath();
    ctx.ellipse(f.x + 2, f.y + 7, r * 0.95, r * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();
    // Colored aura
    ctx.save();
    ctx.shadowColor = c;
    ctx.shadowBlur = 16;
    const sphereGrad = ctx.createRadialGradient(f.x - r * 0.35, f.y - r * 0.35, 0.5, f.x, f.y, r);
    sphereGrad.addColorStop(0,    '#ffffff');
    sphereGrad.addColorStop(0.35, c);
    sphereGrad.addColorStop(1,    shade(c, -55));
    ctx.fillStyle = sphereGrad;
    ctx.beginPath(); ctx.arc(f.x, f.y, r, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    // Glyph
    ctx.fillStyle = '#1a1a1a';
    ctx.font = `bold ${Math.round(r * 1.3)}px Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(powerupGlyph(type), f.x, f.y + 1);
}

function segmentColorRaw(baseColor, pattern, i, total) {
    if (pattern === "rainbow") {
        const hsl = hexToHsl(baseColor);
        const h = (hsl.h + i * (300 / total)) % 360;
        return `hsl(${h}, ${Math.max(50, hsl.s)}%, ${Math.max(45, hsl.l)}%)`;
    }
    if (pattern === "stripes") {
        return Math.floor(i / 2) % 2 === 0 ? baseColor : shade(baseColor, -45);
    }
    return i % 2 === 0 ? shade(baseColor, -10) : baseColor;
}

function drawSnake(s, isMe) {
    const total = s.body.length;
    if (total === 0) { drawSnakeHead(s, isMe); return; }
    if (s.team && (s.team === 'red' || s.team === 'blue')) {
        s.color = s.team === 'red' ? '#f85149' : '#58a6ff';
    }
    const pattern = s.pattern || "solid";

    if (s.shield) {
        ctx.save();
        const t = Date.now() / 250;
        ctx.strokeStyle = `rgba(120, 180, 255, ${0.6 + 0.3 * Math.sin(t)})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(s.x, s.y, 22 + 2 * Math.sin(t * 2), 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
    }
    if (s.gold) {
        ctx.save();
        ctx.shadowColor = '#facc15';
        ctx.shadowBlur = 18;
        ctx.fillStyle = 'rgba(250, 204, 21, 0.001)';
        ctx.beginPath(); ctx.arc(s.x, s.y, 16, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
    }

    const radii = new Array(total);
    const perp = new Array(total);
    for (let i = 0; i < total; i++) {
        const taper = (total - i) / total;
        radii[i] = Math.max(11 * Math.sin(taper * Math.PI / 2), 3);
        let dx, dy;
        if (i === 0)                  { dx = s.body[i].x - s.x;             dy = s.body[i].y - s.y; }
        else if (i === total - 1)     { dx = s.body[i].x - s.body[i-1].x;   dy = s.body[i].y - s.body[i-1].y; }
        else                          { dx = s.body[i+1].x - s.body[i-1].x; dy = s.body[i+1].y - s.body[i-1].y; }
        const len = Math.sqrt(dx*dx + dy*dy) || 1;
        perp[i] = { nx: -dy / len, ny: dx / len };
    }

    const hp = { nx: -Math.sin(s.angle), ny: Math.cos(s.angle) };

    // Helper: trace the full body silhouette as one closed path.
    const traceBody = () => {
        ctx.moveTo(s.x + hp.nx * 11, s.y + hp.ny * 11);
        for (let i = 0; i < total; i++) {
            ctx.lineTo(s.body[i].x + perp[i].nx * radii[i], s.body[i].y + perp[i].ny * radii[i]);
        }
        const tail = s.body[total - 1];
        ctx.arc(tail.x, tail.y, radii[total - 1], Math.atan2(perp[total-1].ny, perp[total-1].nx), Math.atan2(-perp[total-1].ny, -perp[total-1].nx), false);
        for (let i = total - 1; i >= 0; i--) {
            ctx.lineTo(s.body[i].x - perp[i].nx * radii[i], s.body[i].y - perp[i].ny * radii[i]);
        }
        ctx.closePath();
    };

    // --- 0. Ground shadow (offset silhouette, ~5px down-right) ---
    ctx.save();
    ctx.translate(4, 6);
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath(); traceBody(); ctx.fill();
    ctx.restore();

    // --- 1. Smooth body fill underneath (continuous shape) ---
    ctx.beginPath(); traceBody();
    ctx.fillStyle = shade(s.color, -22);
    ctx.fill();

    // --- 2. Pattern segments on top (alternating / stripes / rainbow) ---
    for (let i = total - 1; i >= 0; i--) {
        ctx.beginPath();
        ctx.arc(s.body[i].x, s.body[i].y, radii[i] * 0.94, 0, Math.PI * 2);
        ctx.fillStyle = segmentColorRaw(s.color, pattern, i, total);
        ctx.fill();
    }

    // --- 3. Per-segment "lit side" highlight — small bright ellipse on the
    //        +perp side of each body segment, oriented along the spine, gives
    //        the 2.5D tube illusion of light coming from one side. ---
    for (let i = 0; i < total; i++) {
        const seg = s.body[i];
        const r = radii[i];
        const hx = seg.x + perp[i].nx * r * 0.45;
        const hy = seg.y + perp[i].ny * r * 0.45;
        const ang = Math.atan2(perp[i].ny, perp[i].nx) + Math.PI / 2;
        ctx.fillStyle = 'rgba(255,255,255,0.28)';
        ctx.beginPath();
        ctx.ellipse(hx, hy, r * 0.85, r * 0.28, ang, 0, Math.PI * 2);
        ctx.fill();
    }

    // --- 4. Dark outline — boss snake gets a fat menacing red rim so it
    //        reads as a threat at a glance even when off-center. ---
    ctx.beginPath(); traceBody();
    if (s.boss) {
        ctx.strokeStyle = "rgba(255, 60, 60, 0.95)";
        ctx.lineWidth = 3;
        ctx.shadowColor = '#f85149';
        ctx.shadowBlur = 14;
    } else {
        ctx.strokeStyle = "rgba(0,0,0,0.36)";
        ctx.lineWidth = 1;
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    drawSnakeTongue(s);
    drawSnakeHead(s, isMe);

    if (s.name) {
        ctx.fillStyle = isMe ? "#ffffff" : "#c9d1d9";
        ctx.font = "bold 12px Arial";
        ctx.textAlign = "center";
        ctx.fillText(s.name, s.x, s.y - 22);
    }
}

function drawSnakeTongue(s) {
    if (s.avatar) return;
    if (playerImages.get(s.id)) return;
    const t = Date.now() / 1000;
    const flicker = Math.sin(t * 5 + s.id * 7) * 0.5 + 0.5;
    if (flicker < 0.45) return;
    const len = 5 + (flicker - 0.45) * 16;
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(s.angle);
    ctx.strokeStyle = "#e84a5a";
    ctx.lineWidth = 1.3;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(12, 0);
    ctx.lineTo(12 + len, 0);
    ctx.moveTo(12 + len, 0);
    ctx.lineTo(12 + len + 2.5, -1.8);
    ctx.moveTo(12 + len, 0);
    ctx.lineTo(12 + len + 2.5, 1.8);
    ctx.stroke();
    ctx.restore();
}

function drawSnakeHead(s, isMe) {
    // Ground shadow (drawn before the translate so it's in world space)
    ctx.fillStyle = 'rgba(0,0,0,0.34)';
    ctx.beginPath();
    ctx.ellipse(s.x + 4, s.y + 7, 14, 5.5, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.translate(s.x, s.y);
    const img = playerImages.get(s.id);
    const hasImage = img && img.complete && img.naturalWidth > 0;

    // Spherical head: radial gradient from light upper-left to dark rim
    const headGrad = ctx.createRadialGradient(-5, -5, 1, 0, 0, 14);
    headGrad.addColorStop(0,    shade(s.color, 55));
    headGrad.addColorStop(0.55, shade(s.color, 10));
    headGrad.addColorStop(1,    shade(s.color, -30));
    ctx.fillStyle = headGrad;
    ctx.beginPath();
    ctx.arc(0, 0, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(0,0,0,0.4)";
    ctx.stroke();
    if (isMe) {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2;
        ctx.stroke();
    }

    if (hasImage) {
        ctx.save();
        ctx.beginPath(); ctx.arc(0, 0, 13, 0, Math.PI * 2); ctx.clip();
        ctx.drawImage(img, -13, -13, 26, 26);
        ctx.restore();
    } else if (s.avatar) {
        ctx.save();
        ctx.beginPath(); ctx.arc(0, 0, 14, 0, Math.PI * 2); ctx.clip();
        const maxWidth = 24;
        let fontSize = 22;
        ctx.font = `${fontSize}px sans-serif`;
        const w = ctx.measureText(s.avatar).width;
        if (w > maxWidth) {
            fontSize = Math.max(8, Math.floor(fontSize * maxWidth / w));
            ctx.font = `${fontSize}px sans-serif`;
        }
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(s.avatar, 0, 1);
        ctx.restore();
    } else {
        // Specular highlight on the spherical head (drawn in pre-rotation space)
        ctx.fillStyle = "rgba(255,255,255,0.35)";
        ctx.beginPath();
        ctx.ellipse(-4.5, -5, 5.5, 3.2, -0.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.rotate(s.angle);
        ctx.fillStyle = "#ffffff";
        ctx.beginPath(); ctx.arc(5, -6, 3.2, 0, Math.PI*2); ctx.fill();
        ctx.beginPath(); ctx.arc(5,  6, 3.2, 0, Math.PI*2); ctx.fill();
        ctx.fillStyle = "#1a1a1a";
        ctx.beginPath(); ctx.arc(6, -6, 1.6, 0, Math.PI*2); ctx.fill();
        ctx.beginPath(); ctx.arc(6,  6, 1.6, 0, Math.PI*2); ctx.fill();
        ctx.fillStyle = "rgba(0,0,0,0.5)";
        ctx.beginPath(); ctx.arc(11, -2, 0.8, 0, Math.PI*2); ctx.fill();
        ctx.beginPath(); ctx.arc(11,  2, 0.8, 0, Math.PI*2); ctx.fill();
    }
    ctx.restore();
}

function renderLeaderboard() {
    if (phase === "playing") {
        leaderboardEl.style.display = "none";
        return;
    }
    leaderboardEl.style.display = "";
    const rows = leaderboard.map(p => {
        const cls = p.id === myId ? "row me" : "row";
        const av = p.avatar ? `${escapeHtml(p.avatar)} ` : "";
        const name = (p.name || "anon") + (p.alive ? "" : " 💀");
        return `<div class="${cls}"><span>${av}${escapeHtml(name)}</span><span>${p.score}</span></div>`;
    }).join("");
    leaderboardRowsEl.innerHTML = rows;
}

// ---------------- fullscreen canvas ----------------
function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    if (!mouse.set) {
        mouse.x = canvas.width / 2;
        mouse.y = canvas.height / 2 - 100;
    }
}
window.addEventListener("resize", resizeCanvas);
resizeCanvas();

// ---------------- init ----------------
showScreen("rooms");
drawSkinPreview();
connect();
render();

// Register the service worker so the page is installable as a PWA. Resolved
// against the document URL (the page itself), so '/sw.js' lands at site root
// regardless of where this module lives under js/.
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(err => {
            console.warn('SW registration failed:', err);
        });
    });
}
