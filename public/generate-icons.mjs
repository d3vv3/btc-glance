import sharp from "sharp";

// Supersampled raster; the continuous corona fits the maskable 80% safe circle.
const size = 1024;
const radius = size * 0.32;
const pixels = Buffer.alloc(size * size * 4);
const mix = (from, to, amount) => from.map((value, channel) => value + (to[channel] - value) * amount);
const smoothstep = (start, end, value) => {
  const t = Math.max(0, Math.min(1, (value - start) / (end - start)));
  return t * t * (3 - 2 * t);
};
for (let y = 0; y < size; y++) {
  for (let x = 0; x < size; x++) {
    const nx = (x + 0.5 - size / 2) / radius;
    const ny = (y + 0.5 - size / 2) / radius;
    const distance = Math.hypot(nx, ny);
    // Continue the edge color into the corona before smoothly fading its alpha.
    const edgeScale = Math.max(1, distance);
    const sx = nx / edgeScale, sy = ny / edgeScale;
    const highlight = Math.exp(-((sx + 0.38) ** 2 + (sy + 0.42) ** 2) / 0.58);
    const warmth = smoothstep(0.1, 1, sy) * 0.68;
    let color = mix([255, 216, 40], [255, 145, 24], warmth);
    color = mix(color, [255, 252, 204], highlight * 0.92);
    color = mix(color, [255, 194, 61], smoothstep(1, .39 / .32, distance));
    const alpha = 1 - smoothstep(1, .39 / .32, distance);
    const offset = (y * size + x) * 4;
    color.forEach((value, channel) => { pixels[offset + channel] = Math.round(value); });
    pixels[offset + 3] = Math.round(alpha * 255);
  }
}
const icon = () => sharp(pixels, { raw: { width: size, height: size, channels: 4 } });
await Promise.all([
  ...[
    ["icon-192.png", 192], ["icon-512.png", 512], ["maskable-512.png", 512],
    ["apple-touch-icon.png", 180],
  ].map(([name, dimension]) => icon().flatten({ background: { r: 24, g: 28, b: 30 } }).resize(dimension, dimension).png().toFile(new URL(`./icons/${name}`, import.meta.url).pathname)),
  ...[
    ["sun-orb-brand-192.png", 192], ["favicon-32.png", 32], ["favicon-48.png", 48],
    ["sun-orb-preview-512.png", 512],
  ].map(([name, dimension]) => icon().resize(dimension, dimension).png().toFile(new URL(`./icons/${name}`, import.meta.url).pathname)),
]);
