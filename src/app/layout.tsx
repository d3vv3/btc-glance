import type { Metadata, Viewport } from "next";
import "./globals.scss";
import { AppShell } from "../components/AppShell";

export const metadata: Metadata = {
  title: "Bitcoin Weather | A market outlook",
  description: "Bitcoin price outlooks from prediction-market quote shares. Explore the distribution, not a promise.",
  applicationName: "Bitcoin Weather",
  appleWebApp: { capable: true, title: "BTC Weather", statusBarStyle: "black-translucent" },
  icons: {
    icon: [
      { url: "/icons/favicon-32.png?v=sun-orb-1", sizes: "32x32", type: "image/png" },
      { url: "/icons/favicon-48.png?v=sun-orb-1", sizes: "48x48", type: "image/png" },
      { url: "/icons/icon-192.png?v=sun-orb-1", sizes: "192x192", type: "image/png" },
    ],
    apple: { url: "/icons/apple-touch-icon.png?v=sun-orb-1", sizes: "180x180", type: "image/png" },
  },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#182024", colorScheme: "dark" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><AppShell>{children}</AppShell></body></html>;
}
