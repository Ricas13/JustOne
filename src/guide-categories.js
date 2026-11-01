// Jellyfin builds the Live TV "Movies / Sports / Kids / News" rows from the
// programme's XMLTV <category>. Provider guides usually carry none, and JustOne's
// own event labels ("Football", "Other") are not the generic words Jellyfin looks
// for. These helpers add the generic category without touching any category that
// is already there.

// Order matters: a kids' movie channel is "Kids", a sports-news channel is "Sports".
const CHANNEL_RULES = [
  // An explicit "Sports" in the name wins over brand rules ("Showtime Sports", "Nick Sports").
  ["Sports", /\bsports?\b/i],
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

const NON_SPORT_TITLE_RE = /\b(?:concert|music|festival|rock in rio|coachella|tomorrowland|glastonbury|jeopardy|tv shows?|premiere|episode|season)\b/i;
const GENERIC_CATEGORY_RE = /^(?:events?|other|general|live|upcoming)?$/i;

/**
 * True when a generated programme should get the generic Sports tag: it is a sport
 * and not already tagged Sport(s). A generic or missing category (DLHD defaults to
 * "Events") is judged by the title, so a festival or concert is not filed under Sports.
 */
export function needsSportsTag(category, name = "") {
  const cat = String(category || "").trim();
  if (!eventIsSport(cat) || /^sports?$/i.test(cat)) return false;
  if (GENERIC_CATEGORY_RE.test(cat) && NON_SPORT_TITLE_RE.test(String(name || ""))) return false;
  return true;
}

/**
 * Add `<category>label</category>` to a programme's XML unless it already has one
 * with that name; keeps whatever the provider supplied. `onlyIfNone` skips
 * programmes that already carry any category (used for inferred channel labels).
 */
export function addCategory(programmeXml, label, { onlyIfNone = false } = {}) {
  const xml = String(programmeXml || "");
  if (!label) return xml;
  // Ignore comments and CDATA so category-looking text inside them is not mistaken for a tag.
  const visible = xml.replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  const existing = [...visible.matchAll(/<category\b[^>]*>([\s\S]*?)<\/category>/gi)].map((m) => m[1].trim().toLowerCase());
  if (onlyIfNone && existing.length) return xml;
  if (existing.includes(label.toLowerCase())) return xml;
  // Insert before the real (last) closing tag, so a "</programme>" inside CDATA or a comment cannot swallow it.
  const close = xml.toLowerCase().lastIndexOf("</programme>");
  if (close < 0) return xml;
  return `${xml.slice(0, close)}  <category>${label}</category>\n${xml.slice(close)}`;
}
