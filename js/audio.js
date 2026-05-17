// Tiny audio module — generates short sounds via Web Audio oscillators.
// Volume + muted state are pushed in from main.js via setVolume / setMuted.

let audioCtx = null;
let _muted = false;
let _volume = 1;

export function setMuted(m) { _muted = !!m; }
export function setVolume(v) { _volume = Math.max(0, Math.min(1, v)); }

function ensureAudio() {
    if (_muted) return null;
    if (!audioCtx) {
        try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
        catch { return null; }
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
}

function tone(freq, dur, type = 'sine', vol = 0.2, delay = 0) {
    const ac = ensureAudio();
    if (!ac) return;
    const t0 = ac.currentTime + delay;
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(vol * _volume, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g); g.connect(ac.destination);
    osc.start(t0); osc.stop(t0 + dur);
}

export function sndEat()       { tone(820, 0.07, 'square', 0.12); tone(1240, 0.06, 'square', 0.10, 0.03); }
export function sndPowerup()   { tone(560, 0.07, 'sine', 0.18); tone(820, 0.07, 'sine', 0.18, 0.05); tone(1180, 0.10, 'sine', 0.20, 0.10); }
export function sndDie()       { tone(180, 0.4, 'sawtooth', 0.22); tone(90, 0.4, 'sawtooth', 0.18, 0.08); }
export function sndCountdown() { tone(1600, 0.04, 'square', 0.14); }
export function sndStart()     { tone(440, 0.08, 'triangle', 0.18); tone(660, 0.08, 'triangle', 0.18, 0.08); tone(880, 0.12, 'triangle', 0.2, 0.16); }
