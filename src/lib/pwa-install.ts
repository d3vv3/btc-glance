export type InstallBrowser = {
  platform: "ios" | "android" | "desktop";
  browser: "safari" | "chrome" | "edge" | "firefox" | "samsung" | "chromium" | "unknown";
};

export function detectInstallBrowser(userAgent: string, platform: string, maxTouchPoints: number): InstallBrowser {
  const ios = /iPad|iPhone|iPod/i.test(userAgent) || (platform === "MacIntel" && maxTouchPoints > 1);
  const os = ios ? "ios" : /Android/i.test(userAgent) ? "android" : "desktop";
  const browser = /EdgiOS|EdgA?\//i.test(userAgent) ? "edge"
    : /FxiOS|Firefox\//i.test(userAgent) ? "firefox"
    : /SamsungBrowser\//i.test(userAgent) ? "samsung"
    : /CriOS|Chrome\//i.test(userAgent) ? "chrome"
    : /Chromium\//i.test(userAgent) ? "chromium"
    : /Safari\//i.test(userAgent) && /Version\//i.test(userAgent) ? "safari" : "unknown";
  return { platform: os, browser };
}

export function installInstructions({ platform, browser }: InstallBrowser): string {
  if (platform === "ios") {
    return browser === "safari"
      ? "In Safari, choose Share, then Add to Home Screen. Enable Open as Web App if shown, then tap Add."
      : "Check Share for Add to Home Screen where supported, and enable Open as Web App if shown. Availability varies by iOS version and browser. If the option is missing, open this page in Safari and choose Share, then Add to Home Screen.";
  }
  if (platform === "android") {
    if (browser === "firefox") return "In Firefox, open the browser menu and choose Install or Add to Home screen, then confirm.";
    if (browser === "samsung") return "In Samsung Internet, open the browser menu and choose Add page to, then Home screen (or Install app where offered).";
    if (["chrome", "chromium", "edge"].includes(browser)) return "Open the browser menu and choose Install app or Add to Home screen where offered, then confirm. The wording varies by browser and version.";
    return "Check your browser menu for Install or Add to Home screen. If neither is offered, open this page in Chrome or another supported browser.";
  }
  if (browser === "firefox") return "Desktop Firefox does not provide built-in web app installation. Open this page in Chrome, Edge, or a supported version of Safari to install it.";
  if (browser === "safari") return "On macOS Sonoma or later, supported Safari versions offer File > Add to Dock. If that option is missing, update macOS/Safari or open this page in Chrome or Edge.";
  if (["chrome", "chromium", "edge"].includes(browser)) return "Check the address bar or browser menu for Install app (in Edge, Apps > Install this site as an app). Availability depends on browser support and site eligibility.";
  return "Check your browser menu for a web app installation option. If none is offered, open this page in Chrome, Edge, or another supported browser.";
}

export function installActionLabel({ platform }: InstallBrowser): string {
  return platform === "ios" ? "Add to Home Screen" : "How to install";
}

export function androidBrowserInstructions({ browser }: InstallBrowser): string {
  return browser === "firefox"
    ? "If opened inside another app, choose Open in Firefox first."
    : "If opened inside another app, open this page in your browser first.";
}

export function isInstalledDisplay(standalone: boolean | undefined, standaloneMode: boolean, minimalUiMode: boolean): boolean {
  return standalone === true || standaloneMode || minimalUiMode;
}
