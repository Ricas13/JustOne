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
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function cleanText(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9 &+\-./:'@]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function initials(value) {
  const words = cleanText(value).split(" ").filter(Boolean);
  if (!words.length) return "TV";
  if (words.length === 1) return words[0].slice(0, 2);
  return `${words[0][0]}${words[words.length - 1][0]}`;
}

function parseMatchup(title) {
  const clean = String(title || "").trim();
  const match = /^(.+?)\s+(?:vs\.?|v\.?|@|x)\s+(.+)$/i.exec(clean);
  return match ? { left: match[1].trim(), right: match[2].trim() } : null;
}

function wrap(value, maxChars, maxLines = 3) {
  const words = cleanText(value).split(" ").filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const next = `${current} ${word}`.trim();
    if (current && next.length > maxChars) {
      lines.push(current);
      if (lines.length >= maxLines) break;
      current = word;
    } else current = next;
  }
  if (current && lines.length < maxLines) lines.push(current);
  return lines;
}

function pixel(raw, width, x, y, rgba) {
  if (x < 0 || y < 0 || x >= width) return;
  const stride = width * 4 + 1;
  const height = raw.length / stride;
  if (y >= height) return;
  const offset = y * stride + 1 + x * 4;
  raw[offset] = rgba[0];
  raw[offset + 1] = rgba[1];
  raw[offset + 2] = rgba[2];
  raw[offset + 3] = rgba[3] ?? 255;
}

function rect(raw, width, x, y, w, h, rgba) {
  for (let yy = Math.max(0, y); yy < y + h; yy++) {
    for (let xx = Math.max(0, x); xx < x + w; xx++) pixel(raw, width, xx, yy, rgba);
  }
}

function circle(raw, width, cx, cy, radius, rgba) {
  const r2 = radius * radius;
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) pixel(raw, width, x, y, rgba);
    }
  }
}

function textWidth(value, scale) {
  return Math.max(0, cleanText(value).length * 6 * scale - scale);
}

function drawText(raw, width, value, x, y, scale, rgba, align = "left") {
  const valueText = cleanText(value);
  let cursor = x;
  if (align === "center") cursor -= Math.floor(textWidth(valueText, scale) / 2);
  for (const char of valueText) {
    const glyph = FONT[char] || FONT[" "];
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (glyph[row][col] === "1") rect(raw, width, cursor + col * scale, y + row * scale, scale, scale, rgba);
      }
    }
    cursor += 6 * scale;
  }
}

function fitScale(value, maxWidth, preferred, min = 2) {
  for (let scale = preferred; scale >= min; scale--) {
    if (textWidth(value, scale) <= maxWidth) return scale;
  }
  return min;
}

function background(raw, width, height, seed) {
  const stride = width * 4 + 1;
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < width; x++) {
      const nx = x / width;
      const ny = y / height;
      const glow = Math.max(0, 1 - Math.hypot(nx - 0.48, ny - 0.43) * 1.45);
      const edge = Math.max(0, Math.hypot(nx - 0.5, ny - 0.5) - 0.3);
      const offset = y * stride + 1 + x * 4;
      raw[offset] = Math.max(14, Math.min(82, Math.round(31 + seed[0] % 20 + glow * 23 - edge * 25)));
      raw[offset + 1] = Math.max(8, Math.min(50, Math.round(16 + seed[7] % 14 + glow * 10 - edge * 18)));
      raw[offset + 2] = Math.max(24, Math.min(104, Math.round(52 + seed[15] % 26 + glow * 31 - edge * 20)));
      raw[offset + 3] = 255;
    }
  }
}

function encode(raw, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 7 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function drawBadge(raw, width, cx, cy, radius, label, fill, textColor) {
  circle(raw, width, cx, cy, radius + 7, [31, 20, 42, 255]);
  circle(raw, width, cx, cy, radius, fill);
  drawText(raw, width, label, cx, cy - Math.round(radius * 0.22), fitScale(label, radius * 1.25, Math.max(3, Math.round(radius / 11))), textColor, "center");
}

export function eventArtworkPng(channel, variant = "program") {
  const square = variant === "channel";
  const width = square ? 512 : 1200;
  const height = square ? 512 : 675;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  const title = channel?.name || "Live Event";
  const category = channel?.event?.category || "Live Event";
  const competition = channel?.event?.competition || channel?.event?.originalCategory || category;
  const matchup = parseMatchup(title);
  const seed = crypto.createHash("sha256").update(`${channel?.id || channel?.tvgId || title}|${title}`).digest();
  background(raw, width, height, seed);

  const white = [246, 243, 248, 255];
  const muted = [200, 190, 210, 255];
  const purple = [107 + seed[2] % 70, 57 + seed[5] % 50, 143 + seed[8] % 65, 255];
  const magenta = [145 + seed[11] % 70, 57 + seed[14] % 55, 117 + seed[17] % 70, 255];
  const panel = [28, 17, 39, 220];

  if (square) {
    drawText(raw, width, category, width / 2, 30, fitScale(category, 430, 4), muted, "center");
    if (matchup) {
      drawBadge(raw, width, 150, 182, 72, initials(matchup.left), purple, white);
      drawBadge(raw, width, 362, 182, 72, initials(matchup.right), magenta, white);
      drawText(raw, width, "VS", width / 2, 162, 5, white, "center");
    } else {
      drawBadge(raw, width, width / 2, 176, 82, initials(title), purple, white);
    }
    const lines = wrap(title, 20, 3);
    const start = matchup ? 302 : 300;
    lines.forEach((line, index) => drawText(raw, width, line, width / 2, start + index * 48, fitScale(line, 440, 5, 3), white, "center"));
    rect(raw, width, 0, height - 9, width, 9, magenta);
    return encode(raw, width, height);
  }

  rect(raw, width, 58, 46, width - 116, height - 92, panel);
  drawText(raw, width, category, width / 2, 76, fitScale(category, 1000, 5, 3), muted, "center");
  if (competition && cleanText(competition) !== cleanText(category)) {
    drawText(raw, width, competition, width / 2, 125, fitScale(competition, 1000, 4, 2), muted, "center");
  }

  if (matchup) {
    drawBadge(raw, width, 310, 315, 105, initials(matchup.left), purple, white);
    drawBadge(raw, width, 890, 315, 105, initials(matchup.right), magenta, white);
    drawText(raw, width, "VS", width / 2, 284, 9, white, "center");
    const leftLines = wrap(matchup.left, 20, 2);
    const rightLines = wrap(matchup.right, 20, 2);
    leftLines.forEach((line, i) => drawText(raw, width, line, 310, 455 + i * 42, fitScale(line, 430, 4, 2), white, "center"));
    rightLines.forEach((line, i) => drawText(raw, width, line, 890, 455 + i * 42, fitScale(line, 430, 4, 2), white, "center"));
  } else {
    const lines = wrap(title, 34, 3);
    const start = lines.length === 1 ? 290 : lines.length === 2 ? 255 : 225;
    lines.forEach((line, i) => drawText(raw, width, line, width / 2, start + i * 70, fitScale(line, 1040, 8, 3), white, "center"));
  }

  drawText(raw, width, "LIVE EVENT", width / 2, 584, 4, muted, "center");
  rect(raw, width, 58, height - 60, width - 116, 8, magenta);
  return encode(raw, width, height);
}
