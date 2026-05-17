import { WebSocketServer } from 'ws';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Redis } from '@upstash/redis';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 8080;
const TICK_RATE = 30;
const TICK_MS = 1000 / TICK_RATE;

// Physics
const SPEED = 3.0;                   // always-on fast pace (was 2.0 + manual boost)
const SEGMENT_DISTANCE = 10;
const INITIAL_SEGMENTS = 15;
const TURN_SPEED = 0.15;
const WORLD_WIDTH = 3000;
const WORLD_HEIGHT = 3000;
const HEAD_RADIUS = 12;
const BODY_HIT_RADIUS = 9;
const FOOD_EAT_DIST = 22;
const SEGMENTS_PER_FOOD = 3;
const FOOD_TARGET_COUNT = 400;
const FOOD_PER_DEAD_SEGMENTS = 3;
const VIEW_RADIUS = 1500;

// Round + room
const ROUND_MS = 3 * 60 * 1000;
const INTERMISSION_MS = 10 * 1000;
const MAX_ROOM_PLAYERS = 8;

const COLORS = ['#56d364', '#f0883e', '#a371f7', '#58a6ff', '#f85149', '#d29922', '#ec4899', '#06b6d4'];
const FOOD_COLORS = ['#ff7b72', '#f0883e', '#d2a8ff', '#79c0ff', '#7ee787'];
const PATTERNS = new Set(['solid', 'stripes', 'rainbow']);

// Power-up foods: rare colored fruits with on-eat effects.
//  - 'gold'   : 5× score multiplier for 10s
//  - 'shield' : invulnerable to snake-vs-snake for 6s
//  - 'speed'  : +50% speed for 5s (stacks with boost)
//  - 'magnet' : pulls nearby regular food toward you for 8s
const POWERUP_SPAWN_CHANCE = 0.045;
const POWERUP_TYPES = ['gold', 'shield', 'speed', 'magnet'];
const POWERUP_EFFECTS = {
    gold:   { duration: 10000, scoreMul: 5 },
    shield: { duration: 6000 },
    speed:  { duration: 5000, speedMul: 1.5 },
    magnet: { duration: 8000, radius: 220, pull: 6 },
};

// Game modes — owner picks in lobby
const MODES = new Set(['ffa', 'lastman', 'teams', 'koth']);

// King of the Hill: small circular hill at map center. +1 score per tick
// (30/sec) for each snake whose head is inside.
const KOTH_HILL_R = 150;

// Static map obstacles — hit one and die. Fractional positions so they
// scale with map size. Skipped in LSS (would crowd the shrinking circle).
const MAP_OBSTACLES = {
    grasslands: [
        { fx: 0.25, fy: 0.25, r: 40 }, { fx: 0.75, fy: 0.25, r: 44 },
        { fx: 0.25, fy: 0.75, r: 42 }, { fx: 0.75, fy: 0.75, r: 40 },
        { fx: 0.50, fy: 0.18, r: 34 }, { fx: 0.50, fy: 0.82, r: 34 },
    ],
    desert: [
        { fx: 0.30, fy: 0.40, r: 36 }, { fx: 0.70, fy: 0.30, r: 34 },
        { fx: 0.70, fy: 0.70, r: 40 }, { fx: 0.30, fy: 0.60, r: 32 },
        { fx: 0.15, fy: 0.50, r: 36 }, { fx: 0.85, fy: 0.50, r: 36 },
    ],
    snow: [
        { fx: 0.30, fy: 0.30, r: 44 }, { fx: 0.70, fy: 0.30, r: 40 },
        { fx: 0.30, fy: 0.70, r: 42 }, { fx: 0.70, fy: 0.70, r: 40 },
        { fx: 0.50, fy: 0.50, r: 36 },
    ],
    lava: [
        { fx: 0.30, fy: 0.30, r: 46 }, { fx: 0.70, fy: 0.70, r: 50 },
        { fx: 0.70, fy: 0.30, r: 44 }, { fx: 0.30, fy: 0.70, r: 44 },
    ],
};

// Bots
const BOT_RESPAWN_MS = 3000;
const BOT_NAMES = ['Boop', 'Zappy', 'Glide', 'Nibble', 'Hiss', 'Coilio', 'Slink', 'Fang', 'Wiggle', 'Snap'];
const BOT_AVATARS = ['🤖', '🐍', '🐉', '🦖', '👾', '🦊', '🦄', '🐺'];
const TEAM_COLORS = { red: '#f85149', blue: '#58a6ff' };

// LSS shrinking-zone parameters
const LSS_GRACE_MS = 30_000;           // 30s before the zone starts to shrink
const LSS_SHRINK_DURATION_MS = 110_000; // shrink takes ~110s
const LSS_MIN_RADIUS = 220;            // minimum radius at full shrink
const LSS_INIT_RADIUS_FRACTION = 0.5; // initial radius as a fraction of map size — capped so the circle inscribes within the map rect

// Built-in maps. Theme only changes visuals; size/foodCount adjust gameplay feel.
const MAPS = [
    { id: 'grasslands', name: 'Grasslands',   theme: 'grasslands', size: 3000, foodCount: 400, icon: '🌿', description: 'Lush meadow — the classic.' },
    { id: 'desert',     name: 'Desert Dunes', theme: 'desert',     size: 3200, foodCount: 350, icon: '🏜️', description: 'Vast & sparse — pick your moments.' },
    { id: 'snow',       name: 'Snow Field',   theme: 'snow',       size: 3000, foodCount: 450, icon: '❄️', description: 'Plenty of food — fast scoring.' },
    { id: 'lava',       name: 'Lava Pit',     theme: 'lava',       size: 2400, foodCount: 320, icon: '🌋', description: 'Tight & deadly — danger up close.' },
];
const MAPS_BY_ID = new Map(MAPS.map(m => [m.id, m]));

const MIME = {
    '.html': 'text/html',
    '.js':   'application/javascript',
    '.css':  'text/css',
    '.json': 'application/manifest+json',
    '.svg':  'image/svg+xml',
    '.png':  'image/png',
    '.webp': 'image/webp',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webmanifest': 'application/manifest+json',
};

const httpServer = http.createServer((req, res) => {
    // Strip query string + fragment — req.url is "/?room=XXX" for invite links
    // but we serve files, not literal paths with query strings.
    const cleanPath = req.url.split('?')[0].split('#')[0];
    const urlPath = (cleanPath === '/' || cleanPath === '') ? '/index.html' : cleanPath;
    const fullPath = path.join(__dirname, urlPath);
    if (!fullPath.startsWith(__dirname)) { res.writeHead(403); res.end('Forbidden'); return; }
    fs.readFile(fullPath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(fullPath)] || 'text/plain' });
        res.end(data);
    });
});

const wss = new WebSocketServer({ server: httpServer });

// -------- Optional Redis persistence --------
// Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to keep rooms alive
// across server restarts. Without these, rooms live only in memory (default).
// Only room metadata is persisted; live game state (positions, food) is not —
// players who were mid-round are simply disconnected, and on first re-join the
// room reopens in its lobby phase with the new joiner as owner.
let redis = null;
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    redis = new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    console.log('redis: persistence enabled');
} else {
    console.log('redis: env vars not set, using in-memory only (rooms reset on restart)');
}
async function persistRoom(room) {
    if (!redis) return;
    try {
        const meta = {
            id: room.id, name: room.name, ownerId: room.ownerId,
            mode: room.mode, mapId: room.mapId,
        };
        await redis.set(`room:${room.id}`, JSON.stringify(meta));
        await redis.sadd('rooms', room.id);
    } catch (err) { console.error('persistRoom failed:', err.message); }
}
async function deletePersistedRoom(roomId) {
    if (!redis) return;
    try {
        await redis.del(`room:${roomId}`);
        await redis.srem('rooms', roomId);
    } catch (err) { console.error('deletePersistedRoom failed:', err.message); }
}
async function loadPersistedRooms() {
    if (!redis) return;
    try {
        const ids = await redis.smembers('rooms');
        for (const id of ids) {
            const raw = await redis.get(`room:${id}`);
            if (!raw) continue;
            // redis.get returns string-or-object depending on SDK version
            const meta = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (!meta || !meta.id) continue;
            rooms.set(meta.id, {
                id: meta.id,
                name: meta.name || `Room ${meta.id}`,
                ownerId: meta.ownerId || 0,
                mapId: meta.mapId || 'grasslands',
                mode: meta.mode || 'ffa',
                members: new Map(),
                phase: 'lobby',
                phaseEndsAt: 0,
                roundStartedAt: 0,
                roundNumber: 0,
                lastStandings: null,
                food: [],
                nextFoodId: 1,
                safeZone: null,
                obstacles: [],
                hill: null,
            });
        }
        console.log(`redis: loaded ${rooms.size} rooms from persistence`);
    } catch (err) { console.error('loadPersistedRooms failed:', err.message); }
}

const sockets = new Map();   // ws -> { snake, roomId|null }
const rooms = new Map();     // roomId -> room
let nextPlayerId = 1;
// Random 4-char room codes (skip 0/O, 1/I/L to avoid confusion when read aloud).
// 30^4 ≈ 810k unique codes — collisions essentially never happen at hobby scale.
const ROOM_CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function genRoomCode() {
    for (let attempt = 0; attempt < 50; attempt++) {
        let id = '';
        for (let i = 0; i < 4; i++) {
            id += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
        }
        if (!rooms.has(id)) return id;
    }
    // Should never get here unless we have ~600k+ rooms
    return 'R' + Date.now().toString(36).slice(-3).toUpperCase();
}

function makeSnake() {
    return {
        id: nextPlayerId++,
        name: 'anon',
        avatar: '',
        avatarImage: null,
        color: COLORS[(nextPlayerId - 1) % COLORS.length],
        pattern: 'solid',
        x: 0, y: 0, angle: 0, body: [],
        targetX: 0, targetY: 0,
        alive: false,
        score: 0,
        growthQueue: 0,
        ready: false,
        // Boost
        boosting: false,
        boostTicks: 0,
        // Power-up effects (timestamps in ms; 0 = inactive)
        goldUntil: 0,
        shieldUntil: 0,
        speedUntil: 0,
        magnetUntil: 0,
        // Team mode
        team: null,    // 'red' | 'blue' | null
        // Last Snake Standing — true once eliminated for the round
        eliminated: false,
    };
}

const MAX_AVATAR_IMAGE_BYTES = 32 * 1024;  // ~32KB cap

function resetSnake(s, room) {
    let x, y;
    // In LSS the playable area IS the safe-zone circle — spawn inside it
    // (with a margin) so snakes aren't insta-killed by the zone check.
    if (room && room.mode === 'lastman' && room.safeZone) {
        const { cx, cy, r } = room.safeZone;
        const spawnR = Math.max(0, r * 0.65);
        const ang = Math.random() * Math.PI * 2;
        const rad = Math.sqrt(Math.random()) * spawnR;
        x = cx + Math.cos(ang) * rad;
        y = cy + Math.sin(ang) * rad;
    } else {
        const size = room ? mapOf(room).size : WORLD_WIDTH;
        x = Math.random() * (size - 400) + 200;
        y = Math.random() * (size - 400) + 200;
    }
    const angle = Math.random() * Math.PI * 2;
    const body = [];
    for (let i = 0; i < INITIAL_SEGMENTS; i++) body.push({ x, y: y + i * SEGMENT_DISTANCE });
    s.x = x; s.y = y; s.angle = angle; s.body = body;
    s.targetX = x; s.targetY = y - 100;
    s.alive = true; s.score = 0; s.growthQueue = 0;
    s.boosting = false; s.boostTicks = 0;
    s.goldUntil = s.shieldUntil = s.speedUntil = s.magnetUntil = 0;
}

function makeRoom(name, ownerId) {
    const id = genRoomCode();
    return {
        id,
        name: (name || `Room ${id}`).slice(0, 24),
        ownerId,
        mapId: 'grasslands',
        mode: 'ffa',
        members: new Map(),
        phase: 'lobby',
        phaseEndsAt: 0,
        roundStartedAt: 0,
        roundNumber: 0,
        lastStandings: null,
        food: [],
        nextFoodId: 1,
        safeZone: null,    // {cx, cy, r} when LSS is running
        obstacles: [],     // [{x, y, r}] static hazards on the map
        hill: null,        // {cx, cy, r} when KOTH is running
    };
}

function mapOf(room) { return MAPS_BY_ID.get(room.mapId) || MAPS[0]; }

function randomFood(room, x, y, color, type) {
    const size = mapOf(room).size;
    // Roll a power-up if no type explicitly requested
    let t = type;
    if (!t) {
        t = Math.random() < POWERUP_SPAWN_CHANCE
            ? POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)]
            : 'regular';
    }
    // In LSS, the playable area is the safe-zone circle — spawn food inside it
    // (using uniform-area sampling: sqrt of random for radius).
    let fx = x, fy = y;
    if (fx === undefined || fy === undefined) {
        if (room.safeZone && room.mode === 'lastman') {
            const { cx, cy, r } = room.safeZone;
            const ang = Math.random() * Math.PI * 2;
            const rad = Math.sqrt(Math.random()) * r * 0.94;
            fx = cx + Math.cos(ang) * rad;
            fy = cy + Math.sin(ang) * rad;
        } else {
            fx = Math.random() * size;
            fy = Math.random() * size;
        }
    }
    return {
        id: room.nextFoodId++,
        x: fx,
        y: fy,
        color: color ?? FOOD_COLORS[Math.floor(Math.random() * FOOD_COLORS.length)],
        type: t,
    };
}

function fillFood(room) {
    const target = mapOf(room).foodCount;
    while (room.food.length < target) room.food.push(randomFood(room));
}

function killSnake(room, s, reason, ws, killer = null) {
    if (!s.alive) return;
    s.alive = false;
    if (room.mode === 'lastman') s.eliminated = true;
    for (let i = 0; i < s.body.length; i += FOOD_PER_DEAD_SEGMENTS) {
        const seg = s.body[i];
        room.food.push(randomFood(room,
            seg.x + (Math.random() - 0.5) * 12,
            seg.y + (Math.random() - 0.5) * 12,
            s.color,
            'regular',
        ));
    }
    // Notify the victim — include killer attribution when known.
    if (ws && typeof ws !== 'string' && ws.readyState === 1) {
        ws.send(JSON.stringify({
            type: 'died',
            reason,
            finalScore: s.score,
            eliminated: !!s.eliminated,
            killerId:     killer ? killer.id     : null,
            killerName:   killer ? killer.name   : null,
            killerAvatar: killer ? killer.avatar : null,
            killerColor:  killer ? killer.color  : null,
            killerScore:  killer ? killer.score  : null,
        }));
    }
    // Notify the killer with a toast ("you killed X (+N)")
    if (killer && !killer.bot) {
        // Find the killer's websocket
        for (const [kws, ks] of room.members) {
            if (ks === killer && typeof kws !== 'string' && kws.readyState === 1) {
                kws.send(JSON.stringify({
                    type: 'kill',
                    victimName: s.name,
                    victimAvatar: s.avatar,
                    victimScore: s.score,
                }));
                break;
            }
        }
    }
    if (s.bot && room.mode !== 'lastman') {
        s.respawnAt = Date.now() + BOT_RESPAWN_MS;
    }
}

function updateSnake(room, s, ws, now) {
    if (!s.alive) return;
    const dx = s.targetX - s.x;
    const dy = s.targetY - s.y;
    const targetAngle = Math.atan2(dy, dx);
    let angleDiff = targetAngle - s.angle;
    while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
    while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
    s.angle += angleDiff * TURN_SPEED;

    // Effective speed: base * optional speed power-up
    let speed = SPEED;
    if (s.speedUntil > now) speed *= POWERUP_EFFECTS.speed.speedMul;

    s.x += Math.cos(s.angle) * speed;
    s.y += Math.sin(s.angle) * speed;

    // LSS skips the rect wall — the safe-zone circle is the only boundary
    // (handled by checkSafeZone). Other modes use the rectangular world.
    if (room.mode !== 'lastman') {
        const size = mapOf(room).size;
        if (s.x < 0 || s.x > size || s.y < 0 || s.y > size) {
            killSnake(room, s, 'wall', ws); return;
        }
    }
    // Obstacle collision (head only) — die instantly.
    if (room.obstacles && room.obstacles.length) {
        for (const o of room.obstacles) {
            const dx = s.x - o.x, dy = s.y - o.y;
            const hit = o.r + HEAD_RADIUS;
            if (dx * dx + dy * dy < hit * hit) {
                killSnake(room, s, 'obstacle', ws); return;
            }
        }
    }

    if (s.growthQueue > 0) {
        const tail = s.body[s.body.length - 1];
        s.body.push({ x: tail.x, y: tail.y });
        s.growthQueue--;
    }
    let leader = { x: s.x, y: s.y };
    for (const seg of s.body) {
        const sdx = leader.x - seg.x;
        const sdy = leader.y - seg.y;
        const dist = Math.sqrt(sdx * sdx + sdy * sdy);
        if (dist > SEGMENT_DISTANCE) {
            const ratio = SEGMENT_DISTANCE / dist;
            seg.x = leader.x - sdx * ratio;
            seg.y = leader.y - sdy * ratio;
        }
        leader = seg;
    }

    // LSS body squeeze: any segment that ended up outside the safe-zone circle
    // gets projected back to just inside the wall. The body bunches up against
    // the boundary instead of trailing into the void.
    if (room.mode === 'lastman' && room.safeZone) {
        const { cx, cy, r } = room.safeZone;
        const maxR = Math.max(0, r - 4);  // small margin from the wall
        const maxR2 = maxR * maxR;
        for (const seg of s.body) {
            const dx = seg.x - cx;
            const dy = seg.y - cy;
            const d2 = dx * dx + dy * dy;
            if (d2 > maxR2 && d2 > 0.001) {
                const d = Math.sqrt(d2);
                const scale = maxR / d;
                seg.x = cx + dx * scale;
                seg.y = cy + dy * scale;
            }
        }
    }
}

function checkSnakeCollisions(room, now) {
    const hitR2 = (HEAD_RADIUS + BODY_HIT_RADIUS) ** 2;
    const deaths = [];
    for (const [wsA, a] of room.members) {
        if (!a.alive) continue;
        if (a.shieldUntil > now) continue;          // shield: invulnerable
        let killer = null;
        for (const [, b] of room.members) {
            if (a === b || !b.alive) continue;
            if (room.mode === 'teams' && a.team && b.team && a.team === b.team) continue;
            for (const seg of b.body) {
                const dx = a.x - seg.x;
                const dy = a.y - seg.y;
                if (dx * dx + dy * dy < hitR2) { killer = b; break; }
            }
            if (killer) break;
        }
        if (killer) deaths.push([a, wsA, killer]);
    }
    for (const [s, ws, killer] of deaths) killSnake(room, s, 'snake', ws, killer);
}

function checkFood(room, now) {
    const eatR2 = FOOD_EAT_DIST * FOOD_EAT_DIST;
    for (const [, s] of room.members) {
        if (!s.alive) continue;

        // Magnet effect: pull nearby regular food toward the head this tick
        if (s.magnetUntil > now) {
            const mr = POWERUP_EFFECTS.magnet.radius;
            const mr2 = mr * mr;
            const pull = POWERUP_EFFECTS.magnet.pull;
            for (const f of room.food) {
                if (f.type !== 'regular') continue;
                const dx = s.x - f.x;
                const dy = s.y - f.y;
                const d2 = dx * dx + dy * dy;
                if (d2 < mr2 && d2 > 0.0001) {
                    const d = Math.sqrt(d2);
                    f.x += (dx / d) * pull;
                    f.y += (dy / d) * pull;
                }
            }
        }

        for (let i = room.food.length - 1; i >= 0; i--) {
            const f = room.food[i];
            const dx = s.x - f.x;
            const dy = s.y - f.y;
            if (dx * dx + dy * dy < eatR2) {
                room.food.splice(i, 1);
                s.growthQueue += SEGMENTS_PER_FOOD;
                const mul = s.goldUntil > now ? POWERUP_EFFECTS.gold.scoreMul : 1;
                s.score += 1 * mul;
                applyPowerup(s, f.type, now);
            }
        }
    }
    fillFood(room);
}

function applyPowerup(s, type, now) {
    const eff = POWERUP_EFFECTS[type];
    if (!eff) return;
    switch (type) {
        case 'gold':   s.goldUntil   = now + eff.duration; break;
        case 'shield': s.shieldUntil = now + eff.duration; break;
        case 'speed':  s.speedUntil  = now + eff.duration; break;
        case 'magnet': s.magnetUntil = now + eff.duration; break;
    }
}

function startGame(room) {
    room.phase = 'playing';
    room.roundStartedAt = Date.now();
    room.phaseEndsAt = room.roundStartedAt + ROUND_MS;
    room.roundNumber++;
    room.lastStandings = null;
    room.food.length = 0;
    room.nextFoodId = 1;

    // LSS: initialize shrinking safe zone centered on the map BEFORE spawning
    // food so randomFood seeds inside the circle.
    const size = mapOf(room).size;
    if (room.mode === 'lastman') {
        room.safeZone = {
            cx: size / 2,
            cy: size / 2,
            r:  size * LSS_INIT_RADIUS_FRACTION,
        };
    } else {
        room.safeZone = null;
    }
    // KOTH: place the hill at map center.
    room.hill = room.mode === 'koth'
        ? { cx: size / 2, cy: size / 2, r: KOTH_HILL_R }
        : null;
    // Obstacles: per-map fractional positions, scaled to current size.
    // Skipped in LSS so the shrinking circle stays uncluttered.
    if (room.mode === 'lastman') {
        room.obstacles = [];
    } else {
        const defs = MAP_OBSTACLES[mapOf(room).theme] || [];
        room.obstacles = defs.map(o => ({ x: o.fx * size, y: o.fy * size, r: o.r }));
    }
    fillFood(room);

    // Teams mode: split members alternately into red/blue, override color
    const memberList = [...room.members.values()];
    for (let i = 0; i < memberList.length; i++) {
        const s = memberList[i];
        resetSnake(s, room);
        s.ready = false;
        s.boosting = false;
        s.eliminated = false;
        s.goldUntil = s.shieldUntil = s.speedUntil = s.magnetUntil = 0;
        if (room.mode === 'teams') {
            s.team = (i % 2 === 0) ? 'red' : 'blue';
        } else {
            s.team = null;
        }
    }
    console.log(`room ${room.id}: round ${room.roundNumber} started — map ${room.mapId}, mode ${room.mode}`);
}

function endRound(room) {
    const standings = [];
    for (const [, s] of room.members) {
        standings.push({
            id: s.id, name: s.name, avatar: s.avatar,
            color: s.color, pattern: s.pattern, score: s.score,
        });
    }
    standings.sort((a, b) => b.score - a.score);
    if (standings.length > 10) standings.length = 10;
    room.lastStandings = standings;
    room.phase = 'intermission';
    room.phaseEndsAt = Date.now() + INTERMISSION_MS;
    console.log(`room ${room.id}: round ${room.roundNumber} ended`);
}

function returnToLobby(room) {
    room.phase = 'lobby';
    room.phaseEndsAt = 0;
    for (const [, s] of room.members) {
        s.alive = false;
        s.body = [];
        s.score = 0;
        s.ready = false;
    }
    console.log(`room ${room.id}: back to lobby`);
}

function buildRoomList() {
    const list = [];
    for (const room of rooms.values()) {
        list.push({
            id: room.id,
            name: room.name,
            phase: room.phase,
            playerCount: room.members.size,
            maxPlayers: MAX_ROOM_PLAYERS,
        });
    }
    return list;
}

function broadcastRoomList() {
    const msg = JSON.stringify({ type: 'roomList', rooms: buildRoomList() });
    for (const [ws, ctx] of sockets) {
        if (!ctx.roomId && ws.readyState === 1) ws.send(msg);
    }
}

function buildLobbySnapshot(room) {
    const players = [];
    for (const [, s] of room.members) {
        players.push({
            id: s.id, name: s.name, avatar: s.avatar,
            color: s.color, pattern: s.pattern,
            ready: s.ready, isOwner: s.id === room.ownerId,
            isBot: !!s.bot,
        });
    }
    const map = mapOf(room);
    return {
        type: 'lobbyState',
        room: { id: room.id, name: room.name, ownerId: room.ownerId, mapId: room.mapId, mode: room.mode },
        map: { id: map.id, name: map.name, theme: map.theme, size: map.size },
        availableMaps: MAPS.map(m => ({
            id: m.id, name: m.name, theme: m.theme,
            size: m.size, foodCount: m.foodCount,
            icon: m.icon, description: m.description,
        })),
        players,
        phase: room.phase,
    };
}

function buildGameSnapshotFor(room, viewer) {
    // Eliminated viewers spectate — pick the first alive snake as their focal
    // point so the view radius and snapshot are centered on something they can
    // actually watch (otherwise we'd use their last position before death).
    let specTarget = null;
    if (viewer.eliminated) {
        for (const [, s] of room.members) {
            if (s.alive) { specTarget = s; break; }
        }
    }
    const cx = specTarget ? specTarget.x : viewer.x;
    const cy = specTarget ? specTarget.y : viewer.y;
    const r2 = (VIEW_RADIUS + 200) ** 2;
    const snakes = [];
    for (const [, s] of room.members) {
        if (!s.alive) continue;
        if (s !== viewer && s !== specTarget) {
            const dx = s.x - cx, dy = s.y - cy;
            if (dx * dx + dy * dy > r2) continue;
        }
        const now = Date.now();
        snakes.push({
            id: s.id, name: s.name, avatar: s.avatar,
            x: s.x, y: s.y, angle: s.angle, body: s.body,
            color: s.color, pattern: s.pattern,
            score: s.score, team: s.team,
            shield:  s.shieldUntil > now,
            gold:    s.goldUntil   > now,
            speed:   s.speedUntil  > now,
            magnet:  s.magnetUntil > now,
        });
    }
    const nearbyFood = [];
    for (const f of room.food) {
        const dx = f.x - cx, dy = f.y - cy;
        if (dx * dx + dy * dy < r2) nearbyFood.push(f);
    }
    const leaderboard = [];
    for (const [, s] of room.members) {
        leaderboard.push({
            id: s.id, name: s.name, avatar: s.avatar,
            color: s.color, pattern: s.pattern, team: s.team,
            score: s.score, alive: s.alive, eliminated: !!s.eliminated,
        });
    }
    leaderboard.sort((a, b) => b.score - a.score);
    if (leaderboard.length > 10) leaderboard.length = 10;
    const map = mapOf(room);
    // Active power-ups remaining (for "me" only — others' shown via flags above)
    const now = Date.now();
    const myEffects = {
        goldRemain:   Math.max(0, viewer.goldUntil   - now),
        shieldRemain: Math.max(0, viewer.shieldUntil - now),
        speedRemain:  Math.max(0, viewer.speedUntil  - now),
        magnetRemain: Math.max(0, viewer.magnetUntil - now),
    };
    return {
        type: 'gameState',
        snakes, food: nearbyFood, leaderboard,
        phase: room.phase, phaseEndsAt: room.phaseEndsAt,
        roundNumber: room.roundNumber,
        standings: room.lastStandings,
        room: { id: room.id, name: room.name, ownerId: room.ownerId, mapId: room.mapId, mode: room.mode },
        map: { id: map.id, name: map.name, theme: map.theme, size: map.size },
        myEffects,
        meEliminated: !!viewer.eliminated,
        spectatingId: specTarget ? specTarget.id : null,
        obstacles: room.obstacles,
        hill: room.hill,
        safeZone: room.safeZone,
    };
}

function broadcastRoom(room) {
    if (room.phase === 'lobby') {
        const snap = JSON.stringify(buildLobbySnapshot(room));
        for (const [ws] of room.members) {
            if (typeof ws === 'string') continue;     // bots have string keys
            if (ws.readyState === 1) ws.send(snap);
        }
    } else {
        for (const [ws, s] of room.members) {
            if (typeof ws === 'string') continue;
            if (ws.readyState !== 1) continue;
            ws.send(JSON.stringify(buildGameSnapshotFor(room, s)));
        }
    }
}

function shrinkSafeZone(room, now) {
    if (!room.safeZone || room.mode !== 'lastman') return;
    const elapsed = now - room.roundStartedAt;
    if (elapsed <= LSS_GRACE_MS) return;  // grace period — zone full size
    const progress = Math.min(1, (elapsed - LSS_GRACE_MS) / LSS_SHRINK_DURATION_MS);
    const initR = mapOf(room).size * LSS_INIT_RADIUS_FRACTION;
    room.safeZone.r = initR - (initR - LSS_MIN_RADIUS) * progress;

    // Cull food that now lies outside the shrinking circle — fillFood will
    // replenish inside the new boundary.
    const { cx, cy, r } = room.safeZone;
    const r2 = r * r;
    for (let i = room.food.length - 1; i >= 0; i--) {
        const f = room.food[i];
        const dx = f.x - cx, dy = f.y - cy;
        if (dx * dx + dy * dy > r2) room.food.splice(i, 1);
    }
}

function checkSafeZone(room) {
    if (!room.safeZone || room.mode !== 'lastman') return;
    const { cx, cy, r } = room.safeZone;
    const r2 = r * r;
    const kills = [];
    for (const [ws, s] of room.members) {
        if (!s.alive) continue;
        const dx = s.x - cx;
        const dy = s.y - cy;
        if (dx * dx + dy * dy > r2) kills.push([s, ws]);
    }
    for (const [s, ws] of kills) killSnake(room, s, 'zone', ws);
}

function tick() {
    const now = Date.now();
    for (const room of rooms.values()) {
        if (room.phase === 'playing') {
            // Run bot AI before physics so the bot's targetX/Y are fresh.
            for (const [, s] of room.members) if (s.bot) updateBotAI(room, s);
            tickBotRespawns(room, now);
            for (const [ws, s] of room.members) updateSnake(room, s, ws, now);
            checkSnakeCollisions(room, now);
            checkFood(room, now);
            shrinkSafeZone(room, now);
            checkSafeZone(room);
            // KOTH: each tick, +1 score to every alive snake whose head is in the hill.
            if (room.mode === 'koth' && room.hill) {
                const { cx, cy, r } = room.hill;
                const r2 = r * r;
                for (const [, s] of room.members) {
                    if (!s.alive) continue;
                    const dx = s.x - cx, dy = s.y - cy;
                    if (dx * dx + dy * dy < r2) s.score += 1;
                }
            }
            // Mode-specific early end conditions
            if (room.mode === 'lastman' && room.members.size >= 2) {
                let alive = 0;
                for (const [, s] of room.members) if (!s.eliminated) alive++;
                if (alive <= 1) endRound(room);
            } else if (room.mode === 'teams' && room.members.size >= 2) {
                let red = 0, blue = 0;
                for (const [, s] of room.members) {
                    if (s.eliminated) continue;
                    if (s.team === 'red')  red++;
                    if (s.team === 'blue') blue++;
                }
                // No early-out for teams in basic mode; rely on timer + scores.
            }
            if (now >= room.phaseEndsAt) endRound(room);
        } else if (room.phase === 'intermission') {
            if (now >= room.phaseEndsAt) returnToLobby(room);
        }
        broadcastRoom(room);
    }
}
setInterval(tick, TICK_MS);

function createRoom(ws, name) {
    const ctx = sockets.get(ws);
    if (!ctx || ctx.roomId) return;
    const room = makeRoom(name || `${ctx.snake.name}'s Room`, ctx.snake.id);
    rooms.set(room.id, room);
    persistRoom(room);
    room.members.set(ws, ctx.snake);
    ctx.roomId = room.id;
    ctx.snake.ready = false;
    ws.send(JSON.stringify({ type: 'joinedRoom', roomId: room.id, ownerId: room.ownerId }));
    console.log(`room ${room.id} created by ${ctx.snake.name}`);
    broadcastRoomList();
}

// ---------------- Bots ----------------
function makeBot() {
    return {
        id: nextPlayerId++,
        name: 'Bot ' + BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)],
        avatar: BOT_AVATARS[Math.floor(Math.random() * BOT_AVATARS.length)],
        avatarImage: null,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        pattern: 'solid',
        x: 0, y: 0, angle: 0, body: [],
        targetX: 0, targetY: 0,
        alive: false,
        score: 0,
        growthQueue: 0,
        ready: true,
        bot: true,
        respawnAt: 0,
        boosting: false,
        boostTicks: 0,
        goldUntil: 0, shieldUntil: 0, speedUntil: 0, magnetUntil: 0,
        team: null,
        eliminated: false,
    };
}

function addBotToRoom(room) {
    if (room.members.size >= MAX_ROOM_PLAYERS) return;
    const bot = makeBot();
    room.members.set('bot_' + bot.id, bot);
    console.log(`room ${room.id}: bot ${bot.name} added (${room.members.size}/${MAX_ROOM_PLAYERS})`);
}

function removeBotFromRoom(room) {
    let lastKey = null;
    for (const [key, s] of room.members) if (s.bot) lastKey = key;
    if (lastKey) {
        const bot = room.members.get(lastKey);
        room.members.delete(lastKey);
        console.log(`room ${room.id}: bot ${bot.name} removed`);
    }
}

function updateBotAI(room, bot) {
    if (!bot.alive) return;

    // ---- 1. Body avoidance: sum repulsion vectors from nearby snake segments ----
    const DANGER_R = 180;
    const DANGER_R2 = DANGER_R * DANGER_R;
    let avoidX = 0, avoidY = 0, dangerCount = 0;
    for (const [, s] of room.members) {
        if (s === bot || !s.alive) continue;
        if (room.mode === 'teams' && s.team && bot.team && s.team === bot.team) continue;
        for (const seg of s.body) {
            const dx = bot.x - seg.x, dy = bot.y - seg.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < DANGER_R2 && d2 > 0.01) {
                const w = 1 - Math.sqrt(d2) / DANGER_R;  // closer = stronger
                avoidX += dx * w; avoidY += dy * w;
                dangerCount++;
            }
        }
    }

    // ---- 2. Hunt mode: if we're bigger than a nearby snake, chase its head ----
    let target = null;
    const HUNT_R2 = 600 * 600;
    if (bot.body.length > 22) {
        let bestD = Infinity;
        for (const [, s] of room.members) {
            if (s === bot || !s.alive) continue;
            if (room.mode === 'teams' && s.team && bot.team && s.team === bot.team) continue;
            if (s.body.length + 5 >= bot.body.length) continue;  // only chase smaller (with margin)
            const dx = s.x - bot.x, dy = s.y - bot.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < bestD && d2 < HUNT_R2) { bestD = d2; target = s; }
        }
    }

    // ---- 3. Fall back to nearest food ----
    if (!target) {
        let bestD = Infinity;
        for (const f of room.food) {
            const dx = f.x - bot.x, dy = f.y - bot.y;
            const d2 = dx * dx + dy * dy;
            // Prefer power-ups slightly (worth more / interesting)
            const weighted = f.type !== 'regular' ? d2 * 0.6 : d2;
            if (weighted < bestD) { bestD = weighted; target = f; }
        }
    }

    if (target) {
        bot.targetX = target.x;
        bot.targetY = target.y;
    }

    // ---- 4. Apply avoidance: override target direction if there's danger nearby ----
    if (dangerCount > 0) {
        // Blend: 70% avoid, 30% target — keeps bot moving but mostly dodging
        const tx = (bot.targetX - bot.x);
        const ty = (bot.targetY - bot.y);
        const tlen = Math.sqrt(tx * tx + ty * ty) || 1;
        const ax = avoidX, ay = avoidY;
        const alen = Math.sqrt(ax * ax + ay * ay) || 1;
        bot.targetX = bot.x + (ax / alen) * 200 * 0.7 + (tx / tlen) * 200 * 0.3;
        bot.targetY = bot.y + (ay / alen) * 200 * 0.7 + (ty / tlen) * 200 * 0.3;
    }

    // ---- 5. Boundary handling: stay in the playable area ----
    if (room.mode === 'lastman' && room.safeZone) {
        const dx = bot.x - room.safeZone.cx, dy = bot.y - room.safeZone.cy;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > room.safeZone.r - 100) {
            bot.targetX = room.safeZone.cx;
            bot.targetY = room.safeZone.cy;
        }
    } else {
        const size = mapOf(room).size;
        const m = 120;
        if (bot.x < m) bot.targetX = Math.max(bot.targetX, size / 2);
        if (bot.x > size - m) bot.targetX = Math.min(bot.targetX, size / 2);
        if (bot.y < m) bot.targetY = Math.max(bot.targetY, size / 2);
        if (bot.y > size - m) bot.targetY = Math.min(bot.targetY, size / 2);
    }
}

function tickBotRespawns(room, now) {
    if (room.mode === 'lastman') return;  // no respawn in elimination
    for (const [, s] of room.members) {
        if (s.bot && !s.alive && s.respawnAt && now >= s.respawnAt) {
            resetSnake(s, room);
            s.respawnAt = 0;
        }
    }
}

function quickPlay(ws) {
    const ctx = sockets.get(ws);
    if (!ctx || ctx.roomId) return;
    // Find the first FFA room in lobby phase with space.
    let target = null;
    for (const room of rooms.values()) {
        if (room.mode === 'ffa' && room.phase === 'lobby' && room.members.size < MAX_ROOM_PLAYERS) {
            target = room; break;
        }
    }
    if (target) {
        joinRoom(ws, target.id);
    } else {
        // No joinable room — create one and become its owner.
        createRoom(ws, `Quick Match`);
    }
    // Auto-ready so the host (or you, if you just created) can hit Start fast.
    const fresh = sockets.get(ws);
    if (fresh && fresh.roomId) {
        const room = rooms.get(fresh.roomId);
        if (room && room.phase === 'lobby') fresh.snake.ready = true;
    }
}

function joinRoom(ws, roomId) {
    const ctx = sockets.get(ws);
    if (!ctx || ctx.roomId) return;
    const room = rooms.get(String(roomId));
    if (!room) { ws.send(JSON.stringify({ type: 'error', message: 'Room not found' })); return; }
    if (room.phase !== 'lobby') { ws.send(JSON.stringify({ type: 'error', message: 'Game already in progress' })); return; }
    if (room.members.size >= MAX_ROOM_PLAYERS) { ws.send(JSON.stringify({ type: 'error', message: 'Room is full' })); return; }
    // If the room is empty (e.g., restored from Redis after a restart), the
    // first joiner becomes the new owner so the room is usable again.
    if (room.members.size === 0) {
        room.ownerId = ctx.snake.id;
        persistRoom(room);
    }
    room.members.set(ws, ctx.snake);
    ctx.roomId = room.id;
    ctx.snake.ready = false;
    ws.send(JSON.stringify({ type: 'joinedRoom', roomId: room.id, ownerId: room.ownerId }));
    // Send each existing member's avatar image to the new joiner.
    for (const [, s] of room.members) {
        if (s !== ctx.snake && s.avatarImage) {
            ws.send(JSON.stringify({ type: 'playerImage', id: s.id, dataUrl: s.avatarImage }));
        }
    }
    // Broadcast the new joiner's image (if any) to existing room members.
    if (ctx.snake.avatarImage) {
        broadcastPlayerImage(ctx.snake.id, ctx.snake.avatarImage, room, ws);
    }
    broadcastRoomList();
}

function broadcastPlayerImage(playerId, dataUrl, room, exceptWs = null) {
    if (!room) return;
    const msg = JSON.stringify({ type: 'playerImage', id: playerId, dataUrl });
    for (const [memberWs] of room.members) {
        if (memberWs === exceptWs) continue;
        if (memberWs.readyState === 1) memberWs.send(msg);
    }
}

function leaveRoom(ws, sendLeftConfirmation = true) {
    const ctx = sockets.get(ws);
    if (!ctx || !ctx.roomId) return;
    const room = rooms.get(ctx.roomId);
    ctx.roomId = null;
    ctx.snake.ready = false;
    if (room) {
        room.members.delete(ws);
        if (room.members.size === 0) {
            rooms.delete(room.id);
            deletePersistedRoom(room.id);
            console.log(`room ${room.id} closed (empty)`);
        } else if (room.ownerId === ctx.snake.id) {
            // Owner left -> close room, kick the rest
            for (const [memberWs] of room.members) {
                const memberCtx = sockets.get(memberWs);
                if (memberCtx) memberCtx.roomId = null;
                if (memberWs.readyState === 1) {
                    memberWs.send(JSON.stringify({ type: 'leftRoom', reason: 'Owner left' }));
                    memberWs.send(JSON.stringify({ type: 'roomList', rooms: buildRoomList() }));
                }
            }
            rooms.delete(room.id);
            deletePersistedRoom(room.id);
            console.log(`room ${room.id} closed (owner left)`);
        }
    }
    if (sendLeftConfirmation && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'leftRoom' }));
        ws.send(JSON.stringify({ type: 'roomList', rooms: buildRoomList() }));
    }
    broadcastRoomList();
}

wss.on('connection', (ws) => {
    const snake = makeSnake();
    sockets.set(ws, { snake, roomId: null });
    console.log(`+ player ${snake.id} connected`);
    ws.send(JSON.stringify({
        type: 'welcome',
        id: snake.id,
        world: { width: WORLD_WIDTH, height: WORLD_HEIGHT },
    }));
    ws.send(JSON.stringify({ type: 'roomList', rooms: buildRoomList() }));

    ws.on('message', (raw) => {
        let msg; try { msg = JSON.parse(raw); } catch { return; }
        const ctx = sockets.get(ws);
        if (!ctx) return;
        const room = ctx.roomId ? rooms.get(ctx.roomId) : null;
        switch (msg.type) {
            case 'setName':
                if (typeof msg.name === 'string') ctx.snake.name = msg.name.slice(0,16).trim() || 'anon';
                break;
            case 'setAvatar':
                if (typeof msg.avatar === 'string') ctx.snake.avatar = msg.avatar.slice(0,8);
                break;
            case 'setAvatarImage':
                if (msg.dataUrl === null) {
                    ctx.snake.avatarImage = null;
                    broadcastPlayerImage(ctx.snake.id, null, room);
                } else if (typeof msg.dataUrl === 'string'
                           && msg.dataUrl.startsWith('data:image/')
                           && msg.dataUrl.length <= MAX_AVATAR_IMAGE_BYTES) {
                    ctx.snake.avatarImage = msg.dataUrl;
                    broadcastPlayerImage(ctx.snake.id, msg.dataUrl, room);
                }
                break;
            case 'setSkin':
                if (typeof msg.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(msg.color)) ctx.snake.color = msg.color;
                if (typeof msg.pattern === 'string' && PATTERNS.has(msg.pattern)) ctx.snake.pattern = msg.pattern;
                break;
            case 'listRooms':
                ws.send(JSON.stringify({ type: 'roomList', rooms: buildRoomList() }));
                break;
            case 'createRoom':
                createRoom(ws, typeof msg.name === 'string' ? msg.name : '');
                break;
            case 'joinRoom':
                joinRoom(ws, msg.roomId);
                break;
            case 'quickPlay':
                quickPlay(ws);
                break;
            case 'addBot':
                if (room && room.phase === 'lobby' && ctx.snake.id === room.ownerId) addBotToRoom(room);
                break;
            case 'removeBot':
                if (room && room.phase === 'lobby' && ctx.snake.id === room.ownerId) removeBotFromRoom(room);
                break;
            case 'leaveRoom':
                leaveRoom(ws);
                break;
            case 'setReady':
                if (room && room.phase === 'lobby') ctx.snake.ready = !!msg.ready;
                break;
            case 'startGame':
                if (room && room.phase === 'lobby' && ctx.snake.id === room.ownerId) {
                    let allReady = true;
                    for (const [, s] of room.members) if (!s.ready) { allReady = false; break; }
                    if (allReady && room.members.size >= 1) startGame(room);
                    else ws.send(JSON.stringify({ type: 'error', message: 'Everyone must be ready' }));
                }
                break;
            case 'input':
                if (room && room.phase === 'playing' && Number.isFinite(msg.x) && Number.isFinite(msg.y)) {
                    ctx.snake.targetX = msg.x;
                    ctx.snake.targetY = msg.y;
                }
                break;
            case 'respawn':
                if (room && room.phase === 'playing' && !ctx.snake.alive
                    && !(room.mode === 'lastman' && ctx.snake.eliminated)) {
                    resetSnake(ctx.snake, room);
                }
                break;
            case 'setMap':
                if (room && room.phase === 'lobby' && ctx.snake.id === room.ownerId
                    && typeof msg.mapId === 'string' && MAPS_BY_ID.has(msg.mapId)) {
                    room.mapId = msg.mapId;
                    persistRoom(room);
                }
                break;
            case 'setMode':
                if (room && room.phase === 'lobby' && ctx.snake.id === room.ownerId
                    && typeof msg.mode === 'string' && MODES.has(msg.mode)) {
                    room.mode = msg.mode;
                    persistRoom(room);
                }
                break;
            case 'setBoost':
                // Manual boost removed — auto-boost is the new default speed.
                // Ignored for backward compatibility with old client builds.
                break;
            case 'emote':
                if (room && room.phase === 'playing' && ctx.snake.alive
                    && typeof msg.emote === 'string' && msg.emote.length <= 4) {
                    const payload = JSON.stringify({ type: 'playerEmote', id: ctx.snake.id, emote: msg.emote });
                    for (const [memberWs] of room.members) {
                        if (typeof memberWs === 'string') continue;
                        if (memberWs.readyState === 1) memberWs.send(payload);
                    }
                }
                break;
        }
    });

    ws.on('close', () => {
        const ctx = sockets.get(ws);
        if (ctx) {
            console.log(`- player ${ctx.snake.id} disconnected`);
            if (ctx.roomId) leaveRoom(ws, false);
            sockets.delete(ws);
        }
    });
});

// Restore rooms from Redis (no-op when env vars aren't set).
await loadPersistedRooms();

httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`snake server listening on :${PORT}`);
});
