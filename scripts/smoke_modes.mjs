// Smoke test: connect a player to a fresh room, switch through each new mode,
// add a bot, start the round, and verify the mode-specific state appears.
//
//   node scripts/smoke_modes.mjs        # uses PORT env or 8131

import { WebSocket } from 'ws';

const PORT = Number(process.env.PORT) || 8131;
const URL  = `ws://localhost:${PORT}`;

function connect() {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(URL);
        const t = setTimeout(() => reject(new Error('connect timeout')), 5000);
        ws.once('open',  () => { clearTimeout(t); resolve(ws); });
        ws.once('error', e => { clearTimeout(t); reject(e); });
    });
}
function send(ws, msg) { ws.send(JSON.stringify(msg)); }
function until(ws, predicate, ms = 15000) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('until timeout')), ms);
        ws.on('message', raw => {
            const msg = JSON.parse(raw);
            if (predicate(msg)) { clearTimeout(t); resolve(msg); }
        });
    });
}

async function testMode(modeId, assertFn) {
    const ws = await connect();
    // Welcome
    const welcome = await until(ws, m => m.type === 'welcome');
    send(ws, { type: 'setName', name: `tester_${modeId}` });
    send(ws, { type: 'createRoom', name: `${modeId}-test` });
    await until(ws, m => m.type === 'joinedRoom');
    send(ws, { type: 'setMode', mode: modeId });
    send(ws, { type: 'setReady', ready: true });
    send(ws, { type: 'addBot' });
    // Wait until the lobbyState confirms our mode change is applied
    await until(ws, m => m.type === 'lobbyState' && m.room && m.room.mode === modeId);
    send(ws, { type: 'startGame' });
    // Get the FIRST gameState that's playing
    const snap = await until(ws, m => m.type === 'gameState' && m.phase === 'playing');
    const result = assertFn(snap);
    ws.close();
    return result;
}

const results = [];
async function run() {
    // Hot Potato: snapshot should have bombHolderId + bombExpiresAt in the future
    results.push(['potato', await testMode('potato', s => {
        if (!s.bombHolderId)         return `FAIL: bombHolderId is ${s.bombHolderId}`;
        if (!(s.bombExpiresAt > Date.now())) return `FAIL: bombExpiresAt not in future (${s.bombExpiresAt})`;
        return `OK: bomb on player ${s.bombHolderId}, expires in ${Math.round((s.bombExpiresAt - Date.now()) / 1000)}s`;
    })]);

    // Gold Rush: food[].type should be 'coin' and have gold color
    results.push(['goldrush', await testMode('goldrush', s => {
        if (!s.food || s.food.length === 0) return 'FAIL: no food in snapshot';
        const coins = s.food.filter(f => f.type === 'coin');
        if (coins.length === 0) return `FAIL: no coins in ${s.food.length} food items (sample: ${JSON.stringify(s.food[0])})`;
        return `OK: ${coins.length} coins / ${s.food.length} food items`;
    })]);

    // Boss Snake: snakes should include one with boss=true
    results.push(['boss', await testMode('boss', s => {
        const boss = s.snakes.find(x => x.boss);
        if (!boss) return `FAIL: no boss in ${s.snakes.length} snakes`;
        if (boss.body.length < 30) return `FAIL: boss too small (${boss.body.length} segments)`;
        return `OK: boss with ${boss.body.length} segments at (${Math.round(boss.x)}, ${Math.round(boss.y)})`;
    })]);

    let fail = 0;
    for (const [name, result] of results) {
        console.log(`[${name}] ${result}`);
        if (result.startsWith('FAIL')) fail++;
    }
    process.exit(fail === 0 ? 0 : 1);
}

run().catch(err => { console.error('test crashed:', err); process.exit(2); });
