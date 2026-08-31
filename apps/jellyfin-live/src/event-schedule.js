const MINUTE = 60 * 1000;

const SPORT_DURATIONS = [
  { re: /\b(?:football|soccer|premier league|championship|la liga|bundesliga|serie a|ligue 1|mls|uefa|fifa|fa cup|carabao)\b/i, minutes: 150, label: "Football" },
  { re: /\b(?:tennis|atp|wta|wimbledon|roland garros|australian open|us open)\b/i, minutes: 240, label: "Tennis" },
  { re: /\b(?:basketball|nba|wnba|euroleague|fiba)\b/i, minutes: 150, label: "Basketball" },
  { re: /\b(?:formula ?1|\bf1\b|motogp|nascar|indycar|motorsport|superbike|racing|grand prix|gran premio)\b/i, minutes: 240, label: "Motorsport" },
  { re: /\b(?:boxing|mma|ufc|bellator|combat|fight|wwe|aew|wrestling)\b/i, minutes: 300, label: "Boxing & MMA" },
  { re: /\b(?:american football|nfl|college football|ncaa football|cfl)\b/i, minutes: 240, label: "American Football" },
  { re: /\b(?:baseball|softball|mlb)\b/i, minutes: 240, label: "Baseball & Softball" },
  { re: /\b(?:ice hockey|nhl|hockey)\b/i, minutes: 180, label: "Ice Hockey" },
  { re: /\b(?:golf|pga|lpga|ryder cup|solheim)\b/i, minutes: 360, label: "Golf" },
  { re: /\b(?:cricket|ipl|t20|test match)\b/i, minutes: 480, label: "Cricket" },
  { re: /\b(?:rugby|six nations)\b/i, minutes: 180, label: "Rugby" },
];

function text(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function scheduleEventKey(value) {
  return text(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(?:uhd|fhd|hd|sd|4k|1080p|720p)\b/g, " ")
    .replace(/[()\[\]]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function providerEventTitle(channel) {
  const name = text(channel?.name || channel?.tvgName);
  const parts = name.split(/\s+(?:—|–)\s+/);
  return parts.length > 1 ? text(parts[0]) : "";
}

function eventSpec(group, title) {
  const haystack = `${group || ""} ${title || ""}`;
  return SPORT_DURATIONS.find((row) => row.re.test(haystack)) || {
    minutes: 180,
    label: "Sports",
  };
}

/**
 * Overlay DLStreams' published schedule onto raw sports-event rows.
 *
 * The source playlist remains the playback owner. This function only adds
 * metadata to rows whose provider event title has an exact normalized match in
 * the current DLStreams schedule. Unmatched events deliberately keep an empty
 * programme list so Jellyfin never receives a fabricated start time.
 */
export function applyEventSchedule(lineup, schedule) {
  let eventRows = 0;
  let matched = 0;
  const rows = (lineup || []).map((channel) => {
    const title = providerEventTitle(channel);
    if (!title) return channel;

    eventRows += 1;
    const scheduled = schedule?.byEvent?.get(scheduleEventKey(title));
    const start = Number(scheduled?.start);
    if (!Number.isFinite(start)) {
      return { ...channel, programmes: [] };
    }

    matched += 1;
    const spec = eventSpec(scheduled?.group || channel.group, scheduled?.title || title);
    const programmeTitle = text(scheduled?.title) || title;
    const subtitle = text(scheduled?.group) || spec.label;
    return {
      ...channel,
      programmes: [{
        start,
        end: start + spec.minutes * MINUTE,
        title: programmeTitle,
        subtitle,
        categories: [...new Set(["Sports", spec.label, subtitle].filter(Boolean))],
        scheduleSource: "dlstreams",
      }],
    };
  });

  return {
    lineup: rows,
    eventRows,
    matched,
    unmatched: Math.max(0, eventRows - matched),
  };
}
