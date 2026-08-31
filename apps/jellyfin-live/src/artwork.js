import crypto from "node:crypto";
import zlib from "node:zlib";

const FONT = {
  A:["01110","10001","10001","11111","10001","10001","10001"], B:["11110","10001","10001","11110","10001","10001","11110"],
  C:["01111","10000","10000","10000","10000","10000","01111"], D:["11110","10001","10001","10001","10001","10001","11110"],
  E:["11111","10000","10000","11110","10000","10000","11111"], F:["11111","10000","10000","11110","10000","10000","10000"],
  G:["01111","10000","10000","10111","10001","10001","01111"], H:["10001","10001","10001","11111","10001","10001","10001"],
  I:["11111","00100","00100","00100","00100","00100","11111"], J:["00111","00010","00010","00010","10010","10010","01100"],
  K:["10001","10010","10100","11000","10100","10010","10001"], L:["10000","10000","10000","10000","10000","10000","11111"],
  M:["10001","11011","10101","10101","10001","10001","10001"], N:["10001","11001","10101","10011","10001","10001","10001"],
  O:["01110","10001","10001","10001","10001","10001","01110"], P:["11110","10001","10001","11110","10000","10000","10000"],
  Q:["01110","10001","10001","10001","10101","10010","01101"], R:["11110","10001","10001","11110","10100","10010","10001"],
  S:["01111","10000","10000","01110","00001","00001","11110"], T:["11111","00100","00100","00100","00100","00100","00100"],
  U:["10001","10001","10001","10001","10001","10001","01110"], V:["10001","10001","10001","10001","10001","01010","00100"],
  W:["10001","10001","10001","10101","10101","10101","01010"], X:["10001","10001","01010","00100","01010","10001","10001"],
  Y:["10001","10001","01010","00100","00100","00100","00100"], Z:["11111","00001","00010","00100","01000","10000","11111"],
  0:["01110","10001","10011","10101","11001","10001","01110"], 1:["00100","01100","00100","00100","00100","00100","01110"],
  2:["01110","10001","00001","00010","00100","01000","11111"], 3:["11110","00001","00001","01110","00001","00001","11110"],
  4:["00010","00110","01010","10010","11111","00010","00010"], 5:["11111","10000","10000","11110","00001","00001","11110"],
  6:["01110","10000","10000","11110","10001","10001","01110"], 7:["11111","00001","00010","00100","01000","01000","01000"],
  8:["01110","10001","10001","01110","10001","10001","01110"], 9:["01110","10001","10001","01111","00001","00001","01110"],
  "&":["01100","10010","10100","01000","10101","10010","01101"], "-":["00000","00000","00000","11111","00000","00000","00000"],
  ".":["00000","00000","00000","00000","00000","01100","01100"], ":":["00000","01100","01100","00000","01100","01100","00000"],
  "/":["00001","00010","00100","01000","10000","00000","00000"], "+":["00000","00100","00100","11111","00100","00100","00000"],
  "'":["00100","00100","00000","00000","00000","00000","00000"], " ":["00000","00000","00000","00000","00000","00000","00000"],
};

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const t = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function safeText(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9 &+\-./:'@]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sportText(value) {
  return safeText(value || "LIVE SPORTS").replace(/^SPORTS\s*\|\s*/i, "") || "LIVE SPORTS";
}

function regularGroupText(value) {
  return safeText(String(value || "")
    .replace(/^TV\s*\|\s*/i, "")
    .replace(/^24\s*\/\s*7\s*\|\s*/i, "")) || "LIVE TV";
}

function tokenOf(url) {
  try {
    const raw = new URL(String(url)).pathname.split("/").pop() || "";
    return decodeURIComponent(raw.replace(/\.png$/i, ""));
  } catch {
    return "";
  }
}

export function artworkContext(lineup, token) {
  for (const ch of lineup || []) {
    if (tokenOf(ch.logo) === token) return { kind: "channel", channel: ch, title: ch.name, sport: ch.group };
    for (const p of ch.programmes || []) {
      if (tokenOf(p.icon) === token) return { kind: "program", channel: ch, program: p, title: p.title, sport: p.categories?.[1] || p.subtitle || ch.group };
    }
  }
  return null;
}

function pixel(raw, width, x, y, rgba) {
  if (x < 0 || y < 0 || x >= width) return;
  const stride = width * 4 + 1;
  const height = raw.length / stride;
  if (y >= height) return;
  const o = y * stride + 1 + x * 4;
  raw[o] = rgba[0]; raw[o + 1] = rgba[1]; raw[o + 2] = rgba[2]; raw[o + 3] = rgba[3] ?? 255;
}

function rect(raw, width, x, y, w, h, rgba) {
  for (let yy = Math.max(0, y); yy < y + h; yy++) {
    for (let xx = Math.max(0, x); xx < x + w; xx++) pixel(raw, width, xx, yy, rgba);
  }
}

function circle(raw, width, cx, cy, radius, rgba) {
  const rr = radius * radius;
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= rr) pixel(raw, width, x, y, rgba);
    }
  }
}

function textWidth(text, scale) {
  return Math.max(0, safeText(text).length * 6 * scale - scale);
}

function drawText(raw, width, text, x, y, scale, rgba, align = "left") {
  const s = safeText(text);
  let px = x;
  if (align === "center") px -= Math.floor(textWidth(s, scale) / 2);
  for (const c of s) {
    const glyph = FONT[c] || FONT[" "];
    for (let gy = 0; gy < 7; gy++) {
      for (let gx = 0; gx < 5; gx++) {
        if (glyph[gy][gx] !== "1") continue;
        rect(raw, width, px + gx * scale, y + gy * scale, scale, scale, rgba);
      }
    }
    px += 6 * scale;
  }
}

function fitScale(text, maxWidth, preferred = 7, min = 3) {
  for (let s = preferred; s >= min; s--) if (textWidth(text, s) <= maxWidth) return s;
  return min;
}

function wrapText(text, maxChars = 24, maxLines = 3) {
  const words = safeText(text).split(" ").filter(Boolean);
  const lines = [""];
  for (const word of words) {
    const i = lines.length - 1;
    const candidate = `${lines[i]} ${word}`.trim();
    if (candidate.length > maxChars && lines[i]) {
      if (lines.length >= maxLines) break;
      lines.push(word);
    } else {
      lines[i] = candidate;
    }
  }
  return lines.filter(Boolean);
}

function initials(name) {
  const words = safeText(name).split(" ").filter(Boolean);
  if (!words.length) return "TV";
  if (words.length === 1) return words[0].slice(0, 2);
  return (words[0][0] + words[words.length - 1][0]).slice(0, 2);
}

function parseEvent(title) {
  const clean = String(title || "").replace(/&amp;/gi, "&").trim();
  const colon = clean.indexOf(":");
  const competition = colon > 0 ? clean.slice(0, colon).trim() : "";
  const event = colon > 0 ? clean.slice(colon + 1).trim() : clean;
  const m = /^(.+?)\s+(?:vs\.?|v\.?|@)\s+(.+)$/i.exec(event);
  return { clean, competition, teamA: m?.[1]?.trim() || "", teamB: m?.[2]?.trim() || "" };
}

function renderBackground(raw, width, height, seed) {
  const stride = width * 4 + 1;
  const baseR = 18 + seed[0] % 18;
  const baseG = 12 + seed[7] % 16;
  const baseB = 24 + seed[15] % 24;
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    const ny = Math.abs((y - height / 2) / (height / 2));
    for (let x = 0; x < width; x++) {
      const nx = Math.abs((x - width / 2) / (width / 2));
      const glow = Math.max(0, 1 - (nx * nx + ny * ny) * 0.78);
      const diagonal = (x / width) * 16 + (y / height) * 12;
      const vignette = Math.max(0, (nx * nx + ny * ny - 0.35) * 18);
      const o = y * stride + 1 + x * 4;
      raw[o] = Math.max(8, Math.min(76, Math.round(baseR + diagonal + glow * 16 - vignette)));
      raw[o + 1] = Math.max(8, Math.min(65, Math.round(baseG + diagonal * 0.45 + glow * 8 - vignette)));
      raw[o + 2] = Math.max(12, Math.min(86, Math.round(baseB + diagonal * 0.7 + glow * 18 - vignette)));
      raw[o + 3] = 255;
    }
  }
}

function encode(raw, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 7 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export function artworkPng(token, variant = "program", context = null) {
  const width = variant === "channel" ? 512 : 1200;
  const height = variant === "channel" ? 512 : 675;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  const seed = crypto.createHash("sha256").update(`${token}|${context?.title || ""}`).digest();
  renderBackground(raw, width, height, seed);

  const white = [244, 242, 238, 255];
  const muted = [186, 181, 184, 255];
  const panel = [32, 24, 36, 255];
  const accentA = [112 + seed[2] % 95, 90 + seed[5] % 110, 96 + seed[8] % 105, 255];
  const accentB = [86 + seed[11] % 105, 96 + seed[14] % 100, 122 + seed[17] % 90, 255];
  const sport = sportText(context?.sport);
  const isSportsEvent = context?.channel?.kind === "sport-slot" || context?.channel?.eventFailover;
  const isRegularChannel = context?.channel?.kind === "static" && !context?.channel?.eventFailover;

  if (variant === "channel") {
    const rawTitle = context?.title || String(token).replace(/^sport-/, "");
    const event = parseEvent(rawTitle);

    if (isSportsEvent && event.teamA && event.teamB) {
      const topLabel = safeText(event.competition || sport);
      drawText(raw, width, topLabel, width / 2, 28, fitScale(topLabel, 440, 3, 2), muted, "center");

      circle(raw, width, 125, 174, 72, panel);
      circle(raw, width, 387, 174, 72, panel);
      circle(raw, width, 125, 174, 63, accentA);
      circle(raw, width, 387, 174, 63, accentB);

      const leftInit = initials(event.teamA);
      const rightInit = initials(event.teamB);
      drawText(raw, width, leftInit, 125, 151, fitScale(leftInit, 96, 7, 4), white, "center");
      drawText(raw, width, rightInit, 387, 151, fitScale(rightInit, 96, 7, 4), white, "center");
      drawText(raw, width, "VS", width / 2, 153, 6, white, "center");

      const aLines = wrapText(event.teamA, 18, 2);
      const bLines = wrapText(event.teamB, 18, 2);
      aLines.forEach((line, i) => drawText(raw, width, line, width / 2, 298 + i * 42, fitScale(line, 440, 4, 2), white, "center"));
      const bStart = aLines.length > 1 ? 386 : 350;
      bLines.forEach((line, i) => drawText(raw, width, line, width / 2, bStart + i * 42, fitScale(line, 440, 4, 2), white, "center"));
      drawText(raw, width, sport, width / 2, 468, fitScale(sport, 420, 3, 2), muted, "center");
      rect(raw, width, 0, height - 8, width, 8, accentB);
      return encode(raw, width, height);
    }

    const title = safeText(rawTitle);
    const lines = wrapText(title, 17, 2);
    const topLabel = isSportsEvent ? sport : "LIVE TV";
    const bottomLabel = isSportsEvent ? `SPORTS ${sport}` : regularGroupText(context?.channel?.group);
    drawText(raw, width, topLabel, width / 2, 32, fitScale(topLabel, 420, 3, 2), muted, "center");
    circle(raw, width, width / 2, 154, 82, panel);
    circle(raw, width, width / 2, 154, 72, accentA);
    const init = initials(title);
    drawText(raw, width, init, width / 2, 129, fitScale(init, 112, 8, 5), white, "center");

    const startY = lines.length === 1 ? 286 : 264;
    lines.forEach((line, i) => {
      drawText(raw, width, line, width / 2, startY + i * 58, fitScale(line, 430, 6, 3), white, "center");
    });

    drawText(raw, width, bottomLabel, width / 2, 445, fitScale(bottomLabel, 420, 3, 2), muted, "center");
    rect(raw, width, 0, height - 8, width, 8, accentB);
    return encode(raw, width, height);
  }

  if (isRegularChannel) {
    const title = safeText(context?.channel?.name || context?.title || token);
    const lines = wrapText(title, 28, 3);
    const badge = initials(title);
    const group = regularGroupText(context?.channel?.group);

    drawText(raw, width, "LIVE TV", width / 2, 42, 4, muted, "center");
    circle(raw, width, width / 2, 212, 92, panel);
    circle(raw, width, width / 2, 212, 80, accentA);
    drawText(raw, width, badge, width / 2, 186, fitScale(badge, 118, 8, 5), white, "center");

    const startY = lines.length === 1 ? 370 : lines.length === 2 ? 342 : 316;
    lines.forEach((line, i) => {
      drawText(raw, width, line, width / 2, startY + i * 72, fitScale(line, 1080, 7, 3), white, "center");
    });
    drawText(raw, width, group, width / 2, 604, fitScale(group, 880, 3, 2), muted, "center");
    rect(raw, width, 0, height - 8, width, 8, accentB);
    return encode(raw, width, height);
  }

  const event = parseEvent(context?.title || token);
  const topLabel = safeText(event.competition || sport);
  drawText(raw, width, topLabel, width / 2, 42, fitScale(topLabel, 1060, 4, 2), muted, "center");

  if (event.teamA && event.teamB) {
    circle(raw, width, 220, 255, 96, panel);
    circle(raw, width, 980, 255, 96, panel);
    circle(raw, width, 220, 255, 84, accentA);
    circle(raw, width, 980, 255, 84, accentB);

    const leftInit = initials(event.teamA);
    const rightInit = initials(event.teamB);
    drawText(raw, width, leftInit, 220, 229, fitScale(leftInit, 126, 8, 5), white, "center");
    drawText(raw, width, rightInit, 980, 229, fitScale(rightInit, 126, 8, 5), white, "center");
    drawText(raw, width, "VS", width / 2, 229, 8, white, "center");

    drawText(raw, width, event.teamA, width / 2, 398, fitScale(event.teamA, 1080, 6, 3), white, "center");
    drawText(raw, width, event.teamB, width / 2, 480, fitScale(event.teamB, 1080, 6, 3), white, "center");
    drawText(raw, width, sport, width / 2, 604, fitScale(sport, 880, 3, 2), muted, "center");
  } else {
    const title = safeText(event.clean);
    const lines = wrapText(title, 28, 3);
    const badge = initials(title);

    circle(raw, width, width / 2, 212, 92, panel);
    circle(raw, width, width / 2, 212, 80, accentA);
    drawText(raw, width, badge, width / 2, 186, fitScale(badge, 118, 8, 5), white, "center");

    const startY = lines.length === 1 ? 370 : lines.length === 2 ? 342 : 316;
    lines.forEach((line, i) => {
      drawText(raw, width, line, width / 2, startY + i * 72, fitScale(line, 1080, 7, 3), white, "center");
    });
    drawText(raw, width, sport, width / 2, 604, fitScale(sport, 880, 3, 2), muted, "center");
  }

  rect(raw, width, 0, height - 8, width, 8, accentB);
  return encode(raw, width, height);
}
