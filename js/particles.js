// Particle system used for eat puffs and death bursts, plus the brief
// white screen flash when YOU die. All draw calls take ctx so this module
// doesn't reach into the DOM.

import { shade } from './utils.js';

const particles = [];
let reduceMotion = false;

export function setParticlesReduceMotion(v) { reduceMotion = !!v; }

export function spawnEatPuff(x, y, color) {
    if (reduceMotion) return;
    for (let i = 0; i < 7; i++) {
        const ang = Math.random() * Math.PI * 2;
        const sp = 1.5 + Math.random() * 2;
        particles.push({
            x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
            r: 1.5 + Math.random() * 1.5,
            color, life: 0, maxLife: 22 + Math.random() * 10,
        });
    }
}

export function spawnDeathBurst(snake) {
    const total = snake.body.length;
    if (total === 0) return;
    // One chunky body-segment particle per segment, flying outward
    for (let i = 0; i < total; i++) {
        const seg = snake.body[i];
        const taper = (total - i) / total;
        const segR = Math.max(11 * Math.sin(taper * Math.PI / 2), 3);
        const dx = seg.x - snake.x;
        const dy = seg.y - snake.y;
        const baseAng = Math.atan2(dy || (Math.random() - 0.5), dx || (Math.random() - 0.5));
        const ang = baseAng + (Math.random() - 0.5) * 0.7;
        const sp = 2 + Math.random() * 3.5;
        particles.push({
            x: seg.x, y: seg.y,
            vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
            r: segR * 0.9,
            color: i % 2 === 0 ? shade(snake.color, -15) : (snake.color || '#7ee787'),
            life: 0, maxLife: 55 + Math.random() * 35,
        });
    }
    // Bright dust particles for sparkle
    for (let i = 0; i < 28; i++) {
        const seg = snake.body[Math.floor(Math.random() * total)] || snake;
        const ang = Math.random() * Math.PI * 2;
        const sp = 3 + Math.random() * 5;
        particles.push({
            x: seg.x, y: seg.y,
            vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
            r: 1 + Math.random() * 2,
            color: '#ffffff', life: 0, maxLife: 28 + Math.random() * 18,
        });
    }
}

export function updateParticles() {
    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx; p.y += p.vy;
        p.vx *= 0.94; p.vy *= 0.94;
        p.life++;
        if (p.life >= p.maxLife) particles.splice(i, 1);
    }
}

export function drawParticles(ctx) {
    for (const p of particles) {
        const a = 1 - p.life / p.maxLife;
        ctx.globalAlpha = a;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * (0.4 + a * 0.6), 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.globalAlpha = 1;
}

// White-to-transparent flash when YOU die.
let deathFlashUntil = 0;
export function triggerDeathFlash() {
    if (reduceMotion) return;
    deathFlashUntil = Date.now() + 280;
}
export function drawDeathFlash(ctx, w, h) {
    if (Date.now() > deathFlashUntil) return;
    const remaining = deathFlashUntil - Date.now();
    const alpha = (remaining / 280) * 0.5;
    ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
    ctx.fillRect(0, 0, w, h);
}
