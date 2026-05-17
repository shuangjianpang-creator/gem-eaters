// Generic helpers used across rendering, network, and UI.

export function lerp(a, b, t) { return a + (b - a) * t; }

export function lerpAngle(a, b, t) {
    let diff = b - a;
    while (diff < -Math.PI) diff += Math.PI * 2;
    while (diff > Math.PI) diff -= Math.PI * 2;
    return a + diff * t;
}

// Deterministic integer hash of two integers — used by the grass / decoration
// generators so the same cell always renders the same way.
export function hash(x, y) {
    let h = (x * 374761393) ^ (y * 668265263);
    h = (h ^ (h >>> 13)) >>> 0;
    return (h * 1274126177) >>> 0;
}

// Smoothed 2D value noise (0..1). Built on top of `hash`.
export function noise2d(x, y) {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const ex = fx * fx * (3 - 2 * fx);
    const ey = fy * fy * (3 - 2 * fy);
    const a = (hash(x0,     y0)     & 0xffffff) / 0xffffff;
    const b = (hash(x0 + 1, y0)     & 0xffffff) / 0xffffff;
    const c = (hash(x0,     y0 + 1) & 0xffffff) / 0xffffff;
    const d = (hash(x0 + 1, y0 + 1) & 0xffffff) / 0xffffff;
    return a * (1 - ex) * (1 - ey) + b * ex * (1 - ey)
         + c * (1 - ex) * ey       + d * ex * ey;
}

export function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// Lighten (delta>0) or darken (delta<0) a #rrggbb color.
export function shade(hex, delta) {
    if (!hex || !hex.startsWith("#")) return hex;
    const n = parseInt(hex.slice(1), 16);
    const r = Math.max(0, Math.min(255, ((n >> 16) & 0xff) + delta));
    const g = Math.max(0, Math.min(255, ((n >> 8) & 0xff) + delta));
    const b = Math.max(0, Math.min(255, (n & 0xff) + delta));
    return `rgb(${r},${g},${b})`;
}

// Convert #rrggbb to {h, s, l} (degrees, percent, percent).
export function hexToHsl(hex) {
    if (!hex.startsWith("#")) return { h: 120, s: 50, l: 50 };
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l: l * 100 };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return { h: h * 60, s: s * 100, l: l * 100 };
}
