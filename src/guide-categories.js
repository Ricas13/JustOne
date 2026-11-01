// Jellyfin builds the Live TV "Movies / Sports / Kids / News" rows from the
// programme's XMLTV <category>. Provider guides usually carry none, and JustOne's
// own event labels ("Football", "Other") are not the generic words Jellyfin looks
// for. These helpers add the generic category without touching any category that
// is already there.

// Order matters: a kids' movie channel is "Kids", a sports-news channel is "Sports".
const CHANNEL_RULES = [
  ["Kids", /\b(?:kids?|junior|jr|nick(?:elodeon|toons|\s?jr)?|teennick|cartoon(?:ito)?|disney|boomerang|toons?|cbeebies|cbbc|baby\s?tv|children|clan|pop\s?max|gulli|tiji|piwi)\b/i],
  ["Movie", /\b(?:cinema|movies?|films?|film4|cinemax|hbo|showtime|starz|sundance|tcm|amc|flix|epix|encore|cine(?:latino)?|pelicul\w*|filmes|kino)\b/i],
  ["Sports", /\b(?:sports?|espn[a-z0-9]*|tsn\d*|laliga\s?tv|sporting\s?tv|benfica\s?tv|mutv|lfctv|chelsea\s?tv|bein|dazn|eurosport|golf|tennis|nba|nfl|nhl|mlb|mls|supersport|racing|motorsport|motogp|f1|ufc|wwe|fight|sportsnet|setanta|sporttv|sport\s?tv|arena\s?sport|premier\s?league|laliga|bundesliga|serie\s?a|ligue\s?1)\b/i],
  ["News", /\b(?:news|cnn|cnbc|msnbc|bloomberg|euronews|al\s?jazeera|weather|noticias|noticiero|newsmax|newsnation|france\s?24|dw|rt)\b/i],
];

/** "Movie" | "Kids" | "Sports" | "News" for an ordinary channel, or null when the name gives no clear signal. */
export function inferChannelCategory(channel) {
  const name = String(channel?.name || "").replace(/&amp;/gi, "&");
  for (const [label, re] of CHANNEL_RULES) if (re.test(name)) return label;
  return null;
}

/** Event channels are sport unless they are clearly music or TV. */
export function eventIsSport(category) {
  return !/^(?:music|tv\s*&\s*entertainment)$/i.test(String(category || "").trim());
}

/**
 * Add `<category>label</category>` to a programme's XML unless it already has one
 * with that name; keeps whatever the provider supplied. `onlyIfNone` skips
 * programmes that already carry any category (used for inferred channel labels).
 */
export function addCategory(programmeXml, label, { onlyIfNone = false } = {}) {
  const xml = String(programmeXml || "");
  if (!label) return xml;
  const existing = [...xml.matchAll(/<category\b[^>]*>([\s\S]*?)<\/category>/gi)].map((m) => m[1].trim().toLowerCase());
  if (onlyIfNone && existing.length) return xml;
  if (existing.includes(label.toLowerCase())) return xml;
  return xml.replace(/<\/programme>/i, `  <category>${label}</category>\n</programme>`);
}
