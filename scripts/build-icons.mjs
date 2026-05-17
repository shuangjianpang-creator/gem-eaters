// Rasterizes icon.svg to WebP at PWA-standard sizes.
// Run: npm run build:icons
//
// Sharp's `density` controls how big the SVG is rasterized internally before
// the resize step. Pick a density proportional to the target size so curves
// stay crisp instead of blurring.

import sharp from 'sharp';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const svgBuf = readFileSync(resolve(root, 'icon.svg'));

const targets = [
    { size: 192, density: 384, out: 'icon-192.webp' },
    { size: 512, density: 768, out: 'icon-512.webp' },
];

for (const { size, density, out } of targets) {
    await sharp(svgBuf, { density })
        .resize(size, size)
        .webp({ quality: 92, effort: 6 })
        .toFile(resolve(root, out));
    console.log(`wrote ${out} (${size}×${size})`);
}
