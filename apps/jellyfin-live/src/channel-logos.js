export function isGeneratedChannelLogo(value) {
  const url = String(value || "").trim();
  return !url
    || /\/jellyfin\/artwork\/channel\//i.test(url)
    || /[?&]justone-rebrand=1(?:&|$)/i.test(url);
}

export function chooseChannelLogo(currentLogo, guideLogo) {
  const current = String(currentLogo || "").trim();
  const guide = String(guideLogo || "").trim();
  if (!isGeneratedChannelLogo(current)) return { logo: current, source: "existing", changed: false };
  if (/^https?:\/\//i.test(guide) && !isGeneratedChannelLogo(guide)) {
    return { logo: guide, source: "epg", changed: true };
  }
  return { logo: current, source: "generated", changed: false };
}
