const ORDER = {
  PT: [
    /^rtp\s*1$/, /^rtp\s*2$/, /^sic$/, /^tvi$/,
    /^(?:rtp\s*3|rtp\s*noticias)$/, /^sic\s*noticias$/, /^cnn\s*portugal$/, /^cmtv$/,
    /^rtp\s*memoria$/, /^rtp\s*africa$/, /^sic\s*mulher$/, /^sic\s*radical$/, /^sic\s*caras$/, /^tvi\s*reality$/,
    /^sport\s*tv\s*1\b/, /^sport\s*tv\s*2\b/, /^sport\s*tv\s*3\b/, /^sport\s*tv\s*4\b/, /^sport\s*tv\s*5\b/, /^sport\s*tv\s*6\b/,
  ],
  GB: [
    /^bbc\s*one\b/, /^bbc\s*two\b/, /^itv\s*1\b/, /^channel\s*4\b/, /^channel\s*5\b/,
    /^bbc\s*three\b/, /^bbc\s*four\b/, /^itv\s*2\b/, /^itv\s*3\b/, /^itv\s*4\b/,
    /^e4\b/, /^more\s*4\b/, /^5\s*star\b/, /^5\s*usa\b/, /^dave\b/, /^really\b/, /^quest\b/,
    /^bbc\s*news\b/, /^sky\s*news\b/, /^gb\s*news\b/,
  ],
  US: [
    /^abc\b/, /^cbs\b/, /^nbc\b/, /^fox\b/, /^pbs\b/, /^(?:the\s+)?cw\b/,
    /^espn$/, /^espn\s*2\b/, /^fs\s*1\b|^fox\s*sports\s*1\b/, /^fs\s*2\b|^fox\s*sports\s*2\b/,
    /^nfl\s*network\b/, /^nba\s*tv\b/, /^mlb\s*network\b/, /^nhl\s*network\b/,
    /^cnn\b/, /^msnbc\b/, /^fox\s*news\b/, /^newsmax\b/,
  ],
  ES: [
    /^la\s*1$/, /^la\s*2$/, /^antena\s*3\b/, /^cuatro\b/, /^telecinco\b/, /^la\s*sexta\b/,
    /^24\s*horas\b/, /^clan\b/, /^teledeporte\b/,
  ],
  FR: [
    /^tf1\b/, /^france\s*2\b/, /^france\s*3\b/, /^canal\+?\b/, /^france\s*5\b/, /^m6\b/,
    /^arte\b/, /^c8\b/, /^w9\b/, /^tmc\b/, /^tfx\b/, /^bfm\s*tv\b/, /^cnews\b/,
  ],
  DE: [
    /^(?:das\s*erste|ard)\b/, /^zdf\b/, /^rtl\b/, /^sat\.?\s*1\b/, /^prosieben\b/, /^vox\b/,
    /^kabel\s*eins\b/, /^rtl\s*(?:zwei|2)\b/, /^3sat\b/, /^arte\b/,
  ],
  IT: [
    /^rai\s*1\b/, /^rai\s*2\b/, /^rai\s*3\b/, /^rete\s*4\b/, /^canale\s*5\b/, /^italia\s*1\b/,
    /^la\s*7\b/, /^tv\s*8\b/, /^nove\b/, /^rai\s*4\b/, /^rai\s*5\b/, /^rai\s*news\s*24\b/,
  ],
  NL: [
    /^npo\s*1\b/, /^npo\s*2\b/, /^npo\s*3\b/, /^rtl\s*4\b/, /^rtl\s*5\b/, /^sbs\s*6\b/,
    /^rtl\s*7\b/, /^veronica\b/, /^net\s*5\b/, /^rtl\s*8\b/,
  ],
  IE: [
    /^rte\s*one\b/, /^rte\s*2\b/, /^virgin\s*media\s*one\b/, /^virgin\s*media\s*two\b/,
    /^virgin\s*media\s*three\b/, /^tg4\b/, /^rte\s*news\b/,
  ],
  CA: [
    /^cbc\b/, /^ctv\b/, /^global\b/, /^citytv\b|^city\s*tv\b/, /^tva\b/, /^tele\s*quebec\b/,
    /^sportsnet\b/, /^tsn\b/,
  ],
  AU: [
    /^abc\s*(?:tv)?\b/, /^sbs\b/, /^(?:seven|7)\b/, /^(?:nine|9)\b/, /^(?:ten|10)\b/,
  ],
  BR: [
    /^(?:tv\s*)?globo\b/, /^record\b/, /^sbt\b/, /^band\b/, /^redetv\b/, /^tv\s*cultura\b/,
  ],
  PL: [
    /^tvp\s*1\b/, /^tvp\s*2\b/, /^tvn\b/, /^polsat\b/, /^tv\s*4\b/, /^tvn\s*7\b/, /^tv\s*puls\b/, /^puls\s*2\b/,
  ],
  CZ: [
    /^(?:ct|ceska\s*televize)\s*1\b/, /^(?:ct|ceska\s*televize)\s*2\b/, /^nova\b/, /^prima\b/,
    /^(?:ct|ceska\s*televize)\s*24\b/, /^(?:ct|ceska\s*televize)\s*sport\b/,
  ],
  GR: [
    /^ert\s*1\b/, /^ert\s*2\b/, /^ert\s*3\b/, /^ant1\b/, /^alpha\b/, /^star\b/, /^skai\b/, /^mega\b/, /^open\b/,
  ],
  IL: [
    /^(?:kan\s*)?11\b/, /^(?:keshet\s*)?12\b/, /^(?:reshet\s*)?13\b/, /^channel\s*14\b/, /^i24\b/,
  ],
  MX: [
    /^las\s*estrellas\b/, /^canal\s*5\b/, /^azteca\s*uno\b/, /^azteca\s*7\b/, /^imagen\b/,
  ],
  TR: [
    /^trt\s*1\b/, /^atv\b/, /^kanal\s*d\b/, /^show\s*tv\b/, /^star\s*tv\b/, /^(?:now|fox)\b/, /^tv\s*8\b/,
  ],
  SE: [
    /^svt\s*1\b/, /^svt\s*2\b/, /^tv\s*4\b/, /^tv\s*3\b/, /^kanal\s*5\b/,
  ],
  DK: [
    /^dr\s*1\b/, /^dr\s*2\b/, /^tv\s*2\b/, /^tv\s*3\b/, /^kanal\s*5\b/,
  ],
  NO: [
    /^nrk\s*1\b/, /^nrk\s*2\b/, /^tv\s*2\b/, /^tvnorge\b/, /^tv\s*3\b/,
  ],
  RO: [
    /^tvr\s*1\b/, /^tvr\s*2\b/, /^pro\s*tv\b/, /^antena\s*1\b/, /^kanal\s*d\b/, /^digi\s*24\b/,
  ],
  RS: [
    /^rts\s*1\b/, /^rts\s*2\b/, /^pink\b/, /^prva\b/, /^b92\b/,
  ],
  SK: [
    /^jednotka\b/, /^dvojka\b/, /^markiza\b/, /^joj\b/, /^doma\b/, /^plus\b/,
  ],
  HR: [
    /^hrt\s*1\b/, /^hrt\s*2\b/, /^rtl\b/, /^nova\s*tv\b/, /^doma\b/,
  ],
  ZA: [
    /^sabc\s*1\b/, /^sabc\s*2\b/, /^sabc\s*3\b/, /^e\s*tv\b/, /^m\s*net\b/, /^supersport\b/,
  ],
  AR: [
    /^telefe\b/, /^el\s*trece\b/, /^america\b/, /^el\s*nueve\b/, /^tv\s*publica\b/,
  ],
};

const COUNTRY_WORDS = /\b(?:usa|us|uk|united kingdom|portugal|spain|france|germany|italy|canada|australia|brazil|poland|czechia|greece|israel|mexico|turkey|sweden|denmark|norway|romania|serbia|slovakia|croatia|south africa|argentina)\b/gi;

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export function sortableChannelName(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(COUNTRY_WORDS, " ")
    .replace(/\b(?:uhd|fhd|hd|sd|4k|1080p|720p)\b/g, " ")
    .replace(/[^a-z0-9+]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function nativeChannelRank(country, name) {
  const rules = ORDER[String(country || "").toUpperCase()] || [];
  const normalized = sortableChannelName(name);
  const index = rules.findIndex((rule) => rule.test(normalized));
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

export function compareCountryChannels(country, a, b) {
  const ar = nativeChannelRank(country, a?.name);
  const br = nativeChannelRank(country, b?.name);
  if (ar !== br) return ar - br;
  return collator.compare(sortableChannelName(a?.name), sortableChannelName(b?.name));
}
