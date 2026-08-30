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
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < width; x++) {
      const mix = Math.floor((x / width) * 35 + (y / height) * 24);
      const o = y * stride + 1 + x * 4;
      raw[o] = Math.min(80, 12 + (seed[0] % 35) + mix);
      raw[o + 1] = Math.min(80, 12 + (seed[7] % 30) + Math.floor(mix * 0.6));
      raw[o + 2] = Math.min(90, 16 + (seed[15] % 40) + Math.floor(mix * 0.8));
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
  const white = [242,242,238,255];
  const muted = [184,184,180,255];
  const accentA = [80 + seed[2] % 130, 80 + seed[5] % 130, 80 + seed[8] % 130, 255];
  const accentB = [80 + seed[11] % 130, 80 + seed[14] % 130, 80 + seed[17] % 130, 255];

  if (variant === "channel") {
    const title = safeText(context?.title || String(token).replace(/^sport-/, ""));
    const lines = title.length > 18 ? [title.slice(0, 18), title.slice(18, 36)] : [title];
    circle(raw, width, width / 2, 150, 82, accentA);
    const init = initials(title);
    drawText(raw, width, init, width / 2, 125, fitScale(init, 120, 8, 5), white, "center");
    lines.forEach((line, i) => drawText(raw, width, line, width / 2, 275 + i * 58, fitScale(line, 440, 6, 3), white, "center"));
    if (context?.sport && context.sport !== context.title) drawText(raw, width, context.sport, width / 2, 430, fitScale(context.sport, 420, 3, 2), muted, "center");
    return encode(raw, width, height);
  }

  const event = parseEvent(context?.title || token);
  const sport = safeText(context?.sport || "LIVE EVENT");
  if (event.teamA && event.teamB) {
    if (event.competition) drawText(raw, width, event.competition, width / 2, 48, fitScale(event.competition, 1080, 4, 2), muted, "center");
    circle(raw, width, 215, 260, 90, accentA);
    circle(raw, width, 985, 260, 90, accentB);
    drawText(raw, width, initials(event.teamA), 215, 235, fitScale(initials(event.teamA), 120, 8, 5), white, "center");
    drawText(raw, width, initials(event.teamB), 985, 235, fitScale(initials(event.teamB), 120, 8, 5), white, "center");
    drawText(raw, width, "VS", width / 2, 235, 8, white, "center");
    drawText(raw, width, event.teamA, width / 2, 400, fitScale(event.teamA, 1080, 6, 3), white, "center");
    drawText(raw, width, event.teamB, width / 2, 485, fitScale(event.teamB, 1080, 6, 3), white, "center");
    drawText(raw, width, sport, width / 2, 610, fitScale(sport, 900, 3, 2), muted, "center");
  } else {
    const title = safeText(event.clean);
    const words = title.split(" ");
    const lines = [""];
    for (const word of words) {
      const i = lines.length - 1;
      const candidate = `${lines[i]} ${word}`.trim();
      if (candidate.length > 28 && lines[i]) lines.push(word);
      else lines[i] = candidate;
      if (lines.length >= 4) break;
    }
    drawText(raw, width, sport, width / 2, 70, fitScale(sport, 900, 4, 2), muted, "center");
    lines.forEach((line, i) => drawText(raw, width, line, width / 2, 220 + i * 82, fitScale(line, 1080, 7, 3), white, "center"));
  }
  return encode(raw, width, height);
}
