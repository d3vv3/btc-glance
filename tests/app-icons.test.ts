import { readFileSync } from "node:fs";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import manifest from "../src/app/manifest";

const image = (name: string) => sharp(new URL(`../public/icons/${name}`, import.meta.url).pathname);

describe("sun orb app branding", () => {
  it.each([
    ["icon-192.png", 192], ["icon-512.png", 512], ["maskable-512.png", 512],
    ["apple-touch-icon.png", 180], ["favicon-32.png", 32], ["favicon-48.png", 48],
    ["sun-orb-preview-512.png", 512],
  ])("provides an opaque native-size PNG: %s", async (name, size) => {
    const metadata = await image(String(name)).metadata();
    expect(metadata).toMatchObject({ format: "png", width: size, height: size, hasAlpha: false });
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
  });

  it("points the manifest at versioned PNGs with matching dimensions", async () => {
    const icons = manifest().icons!;
    expect(icons.map(icon => icon.purpose)).toEqual(["any", "any", "maskable"]);
    for (const icon of icons) {
      const url = new URL(icon.src, "https://weather.example.com");
      expect(url.search).toBe("?v=sun-orb-1");
      const metadata = await sharp(new URL(`../public${url.pathname}`, import.meta.url).pathname).metadata();
      expect(icon.sizes).toBe(`${metadata.width}x${metadata.height}`);
      expect(icon.type).toBe("image/png");
    }
  });

  it("uses the same icon revision in metadata, visible branding and offline assets", () => {
    for (const path of ["src/app/layout.tsx", "src/components/AppShell.tsx", "src/components/Watches.tsx", "public/sw.js"]) {
      const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
      expect(source).toContain("?v=sun-orb-1");
    }
    const worker = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
    for (const name of ["apple-touch-icon.png", "favicon-32.png", "favicon-48.png"]) expect(worker).toContain(name);
  });
});
