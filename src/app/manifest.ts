import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "BTC glance", short_name: "BTC glance",
    description: "BTC glance: A Bitcoin market outlook, with price distributions and personal watches.",
    id: "/", start_url: "/", scope: "/", display: "standalone", background_color: "#f2f4f3", theme_color: "#f2f4f3",
    shortcuts: [
      { name: "Outlook", url: "/" },
      { name: "Watches", url: "/watches" },
      { name: "History", url: "/history" },
    ],
    icons: [
      { src: "/icons/icon-192.png?v=sun-orb-3", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png?v=sun-orb-3", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png?v=sun-orb-3", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
