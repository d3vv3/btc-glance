import { readFileSync } from "node:fs";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import manifest from "../src/app/manifest";

const image = (name: string) => sharp(new URL(`../public/icons/${name}`, import.meta.url).pathname);

describe("sun orb app branding", () => {
  it.each([
    ["icon-192.png", 192], ["icon-512.png", 512], ["maskable-512.png", 512],
    ["apple-touch-icon.png", 180],
  ])("provides an opaque native-size PNG: %s", async (name, size) => {
    const metadata = await image(String(name)).metadata();
    expect(metadata).toMatchObject({ format: "png", width: size, height: size, hasAlpha: false });
  });

  it.each([
    ["sun-orb-brand-192.png", 192], ["sun-orb-preview-512.png", 512],
    ["favicon-32.png", 32], ["favicon-48.png", 48],
  ])("provides transparent branding without a charcoal tile: %s", async (name, size) => {
    expect(await image(String(name)).metadata()).toMatchObject({ format: "png", width: size, height: size, hasAlpha: true });
    const { data, info } = await image(String(name)).raw().toBuffer({ resolveWithObject: true });
    expect(data[3]).toBe(0);
    expect(data[(Math.floor(Number(size) / 2) * info.width + Math.floor(Number(size) / 2)) * info.channels + 3]).toBe(255);
  });

  it.each(["maskable-512.png", "sun-orb-preview-512.png", "favicon-32.png", "favicon-48.png"])("fades directly from the disk with no dark annulus: %s", async name => {
    const { data, info } = await image(name).raw().toBuffer({ resolveWithObject: true });
    for (const angle of [0, Math.PI / 4, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
      let previous = 255;
      for (let radius = Math.floor(info.width * .28); radius <= Math.ceil(info.width * .4); radius++) {
        const x = Math.floor(info.width / 2 + Math.cos(angle) * radius);
        const y = Math.floor(info.height / 2 + Math.sin(angle) * radius);
        const offset = (y * info.width + x) * info.channels;
        const alpha = info.channels === 4 ? data[offset + 3] / 255 : 1;
        const red = data[offset] * alpha + 24 * (1 - alpha);
        expect(red).toBeLessThanOrEqual(previous + 2);
        if (radius <= Math.floor(info.width * .32)) expect(red).toBeGreaterThan(220);
        previous = red;
      }
    }
  });

  it("keeps the sun in the central maskable safe circle", async () => {
    const { data, info } = await image("maskable-512.png").raw().toBuffer({ resolveWithObject: true });
    let unsafePixels = 0;
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        if (Math.hypot(x + 0.5 - 256, y + 0.5 - 256) > 512 * 0.4) {
          const offset = (y * info.width + x) * info.channels;
          if (data[offset] !== 24 || data[offset + 1] !== 28 || data[offset + 2] !== 30) unsafePixels++;
        }
      }
    }
    expect(unsafePixels).toBe(0);
    const pixel = (x: number, y: number) => [...data.subarray((y * 512 + x) * info.channels, (y * 512 + x) * info.channels + 3)];
    const highlight = pixel(185, 178);
    const center = pixel(256, 256);
    const lowerEdge = pixel(256, 415);
    expect(highlight[1]).toBeGreaterThan(center[1]);
    expect(highlight[2]).toBeGreaterThan(center[2]);
    expect(center[0]).toBeGreaterThan(245);
    expect(center[1]).toBeGreaterThan(210);
    expect(lowerEdge[1]).toBeLessThan(center[1]);
    const corona = pixel(430, 256);
    expect(corona[0]).toBeGreaterThan(40);
    expect(corona[1]).toBeGreaterThan(35);
    expect(corona[0]).toBeGreaterThan(corona[2]);
  });

  it.each([32, 48])("retains a warm corona and highlight at favicon size %s", async size => {
    const { data, info } = await image(`favicon-${size}.png`).raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => [...data.subarray((y * size + x) * info.channels, (y * size + x) * info.channels + 3)];
    const center = pixel(Math.floor(size / 2), Math.floor(size / 2));
    const highlight = pixel(Math.round(size * .36), Math.round(size * .35));
    const corona = pixel(Math.floor(size * .82), Math.floor(size * .67));
    expect(center[0]).toBeGreaterThan(245);
    expect(highlight[2]).toBeGreaterThan(center[2]);
    expect(corona[0]).toBeGreaterThan(24);
    expect(corona[0]).toBeGreaterThan(corona[2]);
    expect(data[3]).toBe(0);
  });

  it("points the manifest at versioned PNGs with matching dimensions", async () => {
    const icons = manifest().icons!;
    expect(icons.map(icon => icon.purpose)).toEqual(["any", "any", "maskable"]);
    for (const icon of icons) {
      const url = new URL(icon.src, "https://weather.example.com");
      expect(url.search).toBe("?v=sun-orb-3");
      const metadata = await sharp(new URL(`../public${url.pathname}`, import.meta.url).pathname).metadata();
      expect(icon.sizes).toBe(`${metadata.width}x${metadata.height}`);
      expect(icon.type).toBe("image/png");
    }
  });

  it("uses the same icon revision in metadata, visible branding and offline assets", () => {
    for (const path of ["src/app/layout.tsx", "src/components/AppShell.tsx", "src/components/Watches.tsx", "public/sw.js"]) {
      const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
      expect(source).toContain("?v=sun-orb-3");
    }
    const worker = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
    for (const name of ["apple-touch-icon.png", "favicon-32.png", "favicon-48.png", "sun-orb-brand-192.png"]) expect(worker).toContain(name);
  });
});
