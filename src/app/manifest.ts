import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Bitcoin Weather", short_name: "BTC Weather",
    description: "A Bitcoin market outlook, with price distributions and personal watches.",
    id: "/", start_url: "/", scope: "/", display: "standalone", background_color: "#182024", theme_color: "#182024",
    shortcuts: [
      { name: "Outlook", url: "/" },
      { name: "Watches", url: "/watches" },
      { name: "History", url: "/history" },
    ],
    icons: [
      { src: "/icons/icon-192.png?v=sun-orb-1", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png?v=sun-orb-1", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png?v=sun-orb-1", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
