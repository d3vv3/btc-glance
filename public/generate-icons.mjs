import sharp from "sharp";

// Supersampled raster, with the entire sun inside the maskable 80% safe circle.
const size = 1024;
const radius = size * 0.36;
const pixels = Buffer.alloc(size * size * 3);
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
    let color = [24, 28, 30];
    if (distance <= 1) {
      const highlight = Math.exp(-((nx + 0.38) ** 2 + (ny + 0.42) ** 2) / 0.58);
      const warmth = smoothstep(0.1, 1, ny) * 0.68;
      const rim = smoothstep(0.72, 1, distance) * 0.16;
      color = mix([255, 216, 40], [255, 145, 24], warmth + rim);
      color = mix(color, [255, 252, 204], highlight * 0.92);
    }
    const offset = (y * size + x) * 3;
    color.forEach((value, channel) => { pixels[offset + channel] = Math.round(value); });
  }
}
const icon = () => sharp(pixels, { raw: { width: size, height: size, channels: 3 } });
const weather = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><circle cx="302" cy="207" r="91" fill="#e6ad38"/><g stroke="#e6ad38" stroke-width="9" stroke-linecap="round"><path d="M302 78v-24M302 360v-24M173 207h-24M455 207h-24M211 116l-17-17M393 116l17-17M393 298l17 17"/></g><path d="M144 352c-38 0-65-26-65-62s26-62 60-65c5-50 41-85 87-85 48 0 87 36 91 84 40-3 74 24 74 64s-28 64-68 64Z" fill="#f7f5ee" stroke="#173b57" stroke-width="8"/><g stroke="#8ba9ba" stroke-width="8" stroke-linecap="round"><path d="M149 385h181M184 412h112"/></g></svg>`;
await Promise.all([
  ...[
    ["icon-192.png", 192], ["icon-512.png", 512], ["maskable-512.png", 512],
    ["apple-touch-icon.png", 180], ["favicon-32.png", 32], ["favicon-48.png", 48],
    ["sun-orb-preview-512.png", 512],
  ].map(([name, dimension]) => icon().resize(dimension, dimension).png().toFile(new URL(`./icons/${name}`, import.meta.url).pathname)),
  sharp(Buffer.from(weather)).resize(512, 512).png().toFile(new URL("./weather-mark.png", import.meta.url).pathname),
]);
