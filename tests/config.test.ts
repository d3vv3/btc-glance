import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/server/config";

afterEach(() => { vi.unstubAllEnvs(); });
describe("explicit browser origin configuration", () => {
  it("defaults only outside production; production requires an explicit origin", () => {
    vi.stubEnv("APP_ORIGIN", undefined);
    vi.stubEnv("NODE_ENV", "development");
    expect(config().APP_ORIGIN).toBe("http://localhost:3000");
    vi.stubEnv("NODE_ENV", "production");
    expect(() => config()).toThrow();
  });
  it.each(["http://localhost:3104", "https://weather.example.com", "https://weather.example.com:8443"])("permits intentional local/HTTPS production origin %s", origin => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ORIGIN", origin);
    expect(config().APP_ORIGIN).toBe(origin);
  });
  it.each(["", "null", "http://weather.example.com", "http://127.0.0.1:3104", "http://[::1]:3104", "http://localhost.evil.test:3104", "http://localhost.:3104", "http://192.168.1.10:3104", "ftp://weather.example.com", "https://user:pass@weather.example.com", "https://weather.example.com/", "https://weather.example.com/path", "https://weather.example.com?query=1", "https://weather.example.com#fragment", "https://WEATHER.example.com", "https://weather.example.com:443"])("rejects unsafe or noncanonical origin %s", origin => {
    vi.stubEnv("APP_ORIGIN", origin);
    expect(() => config()).toThrow();
  });
});
