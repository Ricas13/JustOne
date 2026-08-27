import type { Channel } from "./types.js";

export function sanitizeTvgName(name: string): string {
  return String(name)
    .replace(/[\r\n",]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function generateM3u8Playlist(channels: Channel[], origin: string): string {
  const base = origin.replace(/\/$/, "");
  const lines: string[] = ["#EXTM3U"];
  for (const ch of channels) {
    const name = sanitizeTvgName(ch.name || `Channel ${ch.id}`);
    const tvgId = `dlhd-${ch.id}`;
    lines.push(
      `#EXTINF:-1 tvg-id="${tvgId}" tvg-name="${name}" group-title="DaddyLive 24/7",${name}`,
    );
    lines.push(`${base}/api/stream/${ch.id}.m3u8`);
  }
  return lines.join("\n") + "\n";
}
