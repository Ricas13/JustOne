import test from "node:test";
import assert from "node:assert/strict";
import { buildXmlTv, isIdleExternalProgramme } from "../src/guide.js";
import { parseXmlTv } from "../src/organizer.js";

const NOW = Date.UTC(2026, 7, 31, 12, 0, 0);

function guide(programmes) {
  const parsed = parseXmlTv(`<?xml version="1.0"?><tv>
    <channel id="CanalPlusSport4.cz"><display-name>CANAL+ Sport 4</display-name></channel>
    ${programmes.join("\n")}
  </tv>`);
  parsed.sourceUrl = "https://epgshare01.online/epgshare01/epg_ripper_CZ1.xml.gz";
  return parsed;
}

function programme(title, start = "20260831110000 +0000", stop = "20260831150000 +0000") {
  return `<programme start="${start}" stop="${stop}" channel="CanalPlusSport4.cz"><title>${title}</title><icon src="https://example.test/placeholder.png" /></programme>`;
}

const channel = {
  id: "canal4",
  kind: "static",
  tvgId: "justone.canal4",
  sourceTvgIds: ["CanalPlusSport4.cz"],
  name: "CANAL+ Sport 4",
  country: "CZ",
  logo: "https://example.test/canal4.png",
};

test("idle programme detector recognizes common off-air guide filler", () => {
  assert.equal(isIdleExternalProgramme(programme("CANAL+ Sport - přestávka ve vysílání")), true);
  assert.equal(isIdleExternalProgramme(programme("No Data")), true);
  assert.equal(isIdleExternalProgramme(programme("Off Air")), true);
  assert.equal(isIdleExternalProgramme(programme("Premier League: Arsenal vs Chelsea")), false);
});

test("off-air guide filler creates an empty XMLTV gap instead of a Home-screen card", () => {
  const xml = buildXmlTv([channel], [guide([
    programme("CANAL+ Sport - přestávka ve vysílání"),
  ])], { now: NOW });

  assert.match(xml, /<channel id="justone\.canal4">/);
  assert.doesNotMatch(xml, /<programme\b/);
  assert.doesNotMatch(xml, /přestávka ve vysílání|Schedule unavailable|placeholder\.png/i);
});

test("real programmes survive while adjacent off-air filler is suppressed", () => {
  const xml = buildXmlTv([channel], [guide([
    programme("CANAL+ Sport - přestávka ve vysílání", "20260831110000 +0000", "20260831130000 +0000"),
    programme("Premier League: Arsenal vs Chelsea", "20260831130000 +0000", "20260831150000 +0000"),
  ])], { now: NOW });

  assert.match(xml, /Premier League: Arsenal vs Chelsea/);
  assert.doesNotMatch(xml, /přestávka ve vysílání/);
  assert.equal((xml.match(/<programme\b/g) || []).length, 1);
});
