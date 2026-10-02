import type { Metadata, Viewport } from "next";
import "./globals.scss";
import { AppShell } from "../components/AppShell";
import { themeBootstrap } from "../lib/theme";

export const metadata: Metadata = {
  title: "BTC glance | A market outlook",
  description: "BTC glance: Bitcoin price outlooks from prediction-market quote shares. Explore the distribution, not a promise.",
  applicationName: "BTC glance",
  appleWebApp: { capable: true, title: "BTC glance", statusBarStyle: "black-translucent" },
  icons: {
    icon: [
      { url: "/icons/favicon-32.png?v=sun-orb-3", sizes: "32x32", type: "image/png" },
      { url: "/icons/favicon-48.png?v=sun-orb-3", sizes: "48x48", type: "image/png" },
      { url: "/icons/icon-192.png?v=sun-orb-3", sizes: "192x192", type: "image/png" },
    ],
    apple: { url: "/icons/apple-touch-icon.png?v=sun-orb-3", sizes: "180x180", type: "image/png" },
  },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: [{ media: "(prefers-color-scheme: light)", color: "#f2f4f3" }, { media: "(prefers-color-scheme: dark)", color: "#182024" }], colorScheme: "light dark" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{ __html: themeBootstrap }} /></head><body><AppShell>{children}</AppShell></body></html>;
}
