import { matchGuideChannel } from "./guide.js";

export function isGeneratedChannelLogo(value) {
  const url = String(value || "").trim();
  return !url || /\/jellyfin\/artwork\/channel\//i.test(url);
}

function usableGuideLogo(value) {
  const url = String(value || "").trim();
  return /^https?:\/\//i.test(url) && !isGeneratedChannelLogo(url);
}

export function applyGuideChannelLogos(lineup, docs = []) {
  let applied = 0;
  let keptExisting = 0;
  let generatedRemaining = 0;

  for (const ch of lineup || []) {
    if (ch?.kind !== "static") continue;

    if (!isGeneratedChannelLogo(ch.logo)) {
      keptExisting += 1;
      continue;
    }

    const hit = matchGuideChannel(ch, docs);
    const guideLogo = String(hit?.meta?.icon || "").trim();
    if (usableGuideLogo(guideLogo)) {
      ch.logo = guideLogo;
      ch.logoSource = "epg";
      applied += 1;
    } else {
      generatedRemaining += 1;
    }
  }

  return { applied, keptExisting, generatedRemaining };
}
