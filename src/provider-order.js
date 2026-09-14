import fsp from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { normalize } from "./util.js";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_FILE = path.join(config.dataDir, "provider-order-cache.json");

const REMOTE_LINEUPS = {
  GB: {
    provider: "Sky TV UK",
    url: "https://raw.githubusercontent.com/PiratesIRC/Dispatcharr-Lineuparr-Plugin/main/Lineuparr/UK_SkyTV_ENG_full_lineup.json",
  },
  US: {
    provider: "DIRECTV Premier",
    url: "https://raw.githubusercontent.com/PiratesIRC/Dispatcharr-Lineuparr-Plugin/main/Lineuparr/US_DirecTV-Premier_lineup.json",
  },
};

const COUNTRY_TOKENS = new Set(["uk","gb","usa","us","pt","portugal","england"]);
const QUALITY_TOKENS = new Set(["hd","fhd","uhd","4k","sd"]);
const NUMBER_WORDS = new Map([
  ["one", "1"], ["two", "2"], ["three", "3"], ["four", "4"], ["five", "5"],
  ["six", "6"], ["seven", "7"], ["eight", "8"], ["nine", "9"], ["ten", "10"],
]);

function key(value) {
  let tokens = normalize(value).split(" ").filter(Boolean);
  while (tokens.length > 1 && COUNTRY_TOKENS.has(tokens[0])) tokens.shift();
  while (tokens.length > 1 && COUNTRY_TOKENS.has(tokens[tokens.length - 1])) tokens.pop();
  tokens = tokens
    .filter((token) => !QUALITY_TOKENS.has(token))
    .map((token) => NUMBER_WORDS.get(token) || token);
  return tokens.join(" ");
}

function keyVariants(value) {
  const base = key(value);
  if (!base) return [];
  const out = new Set([base]);
  out.add(base.replace(/\b(?:east|west|pacific)\b/g, " ").replace(/\s+/g, " ").trim());
  out.add(base.replace(/^the\s+/, ""));
  return [...out].filter(Boolean);
}

function flattenLineup(payload) {
  const out = [];
  for (const rows of Object.values(payload?.categories || {})) {
    for (const row of Array.isArray(rows) ? rows : []) {
      const number = Number(row.number);
      if (!row?.name || !Number.isFinite(number)) continue;
      out.push({ name: String(row.name), number, aliases: Array.isArray(row.aliases) ? row.aliases : [] });
    }
  }
  return out;
}

function add(index, row, provider, source = "provider") {
  for (const value of [row.name, ...(row.aliases || [])]) {
    for (const k of keyVariants(value)) {
      const current = index.get(k);
      if (!current || Number(row.number) < current.position || source === "official-override") {
        index.set(k, {
          position: Number(row.number),
          provider,
          source,
          matchedName: row.name,
        });
      }
    }
  }
}

function addRows(index, rows, provider, source) {
  for (const row of rows) add(index, row, provider, source);
}

// Current Sky Glass/Stream positions from Sky's own 2026 channel list. These
// override the broader community Sky-Q baseline where Sky has since moved or
// renamed channels.
const SKY_CURRENT = [
  ["BBC One",101],["BBC Two",102],["ITV1",103],["Channel 4",104],["Channel 5",105],
  ["Sky One",106],["Sky Showcase",106],["Sky Witness",107],["Sky Atlantic",108],["Sky Comedy",109],
  ["Sky Documentaries",110],["Sky Crime",111],["Sky Arts",112],["Sky Nature",113],["Sky Sci-Fi",114],["Sky History",115],
  ["BBC Three",118],["BBC Four",119],["U&alibi",120],["U&GOLD",121],["ITV2",122],["ITV3",123],["ITV4",124],
  ["E4",126],["More4",127],["5STAR",128],["5 USA",129],["U&Dave",130],["U&W",131],["U&Drama",132],["U&YESTERDAY",133],["U&Eden",134],
  ["Comedy Central",135],["Comedy Xtra",136],["MTV",137],["Discovery",138],["TLC",139],["Investigation Discovery",140],["ID",140],
  ["Animal Planet",141],["Crime + Investigation",142],["Sky History 2",143],["National Geographic",144],["National Geographic Wild",145],
  ["Discovery Turbo",146],["Discovery History",147],["Discovery Science",148],["Quest",149],["Quest Red",150],["DMAX",151],["Food Network",152],["Really",153],
  ["True Crime",155],["Legend",156],["True Crime Xtra",157],["Sky Mix",158],["Challenge",159],["4seven",163],["E4 Extra",164],["5ACTION",165],["5SELECT",166],
  ["GREAT! TV",167],["BLAZE",169],["PBS America",170],["Together TV",171],["BBC Scotland",173],["BBC ALBA",174],
  ["CBBC",201],["CBeebies",202],["Sky Kids",203],["Disney Junior",204],["Nickelodeon",205],["Nicktoons",206],["Nick Jr.",207],["Nick Jr. Too",208],
  ["Cartoon Network",209],["Boomerang",210],["Cartoonito",211],["BabyTV",212],
  ["Sky Premiere",301],["Sky Cinema Premiere",301],["Sky Select",302],["Sky Cinema Select",302],["Sky Hits",303],["Sky Cinema Hits",303],
  ["Sky Family",304],["Sky Cinema Family",304],["Disney+ Cinema",305],["Sky Action",306],["Sky Cinema Action",306],["Sky Greats",307],["Sky Cinema Greats",307],
  ["Sky Cinema",308],["Sky Thriller",309],["Sky Cinema Thriller",309],["Sky Drama",310],["Sky Cinema Drama",310],["Sky Sci-Fi Horror",311],["Sky Cinema Sci-Fi Horror",311],
  ["Film4",312],["Movies24",313],["Movies24+",314],["Sky Animation",315],["Sky Cinema Animation",315],["Legend Xtra",316],["GREAT! Action",317],["GREAT! Mystery",318],["GREAT! Romance",319],
  ["Clubland TV",354],["NOW 70s",355],["NOW 80s",356],["NOW 90s & 00s",357],["NOW ROCK",358],
  ["Sky Sports Main Event",401],["Sky Sports Premier League",402],["Sky Sports Football",403],["Sky Sports+",404],["Sky Sports Cricket",405],["Sky Sports Golf",406],
  ["Sky Sports F1",407],["Sky Sports Tennis",408],["Sky Sports News",409],["Sky Sports Action",410],["Sky Sports Racing",411],["Sky Sports Mix",412],
  ["TNT Sports 1",413],["TNT Sports 2",414],["TNT Sports 3",415],["TNT Sports 4",416],["Ginx eSports TV",417],["MUTV",418],["LFCTV",419],
  ["Sky News",501],["BBC News",502],["BBC Parliament",503],["CNBC",504],["Bloomberg",505],["CNN International",506],["GB News",509],["Euronews",510],["France 24",512],
].map(([name, number]) => ({ name, number }));

// MEO ordering. Current public MEO grids keep RTP1/RTP2/SIC/TVI at 1-4 and
// the same broad Portuguese news/sport/kids/movie blocks. DAZN is kept in the
// old Eleven Sports position family so the rebrand preserves familiar order.
const MEO_PT = [
  ["RTP 1",1],["RTP 2",2],["SIC",3],["TVI",4],["SIC Notícias",5],["RTP 3",6],["RTP Notícias",6],["CNN Portugal",7],["CMTV",8],["News Now",9],
  ["Globo",10],["Canal 11",11],["11",11],["V+ TVI",12],["SIC Mulher",13],["SIC Novelas",14],["Porto Canal",15],["Veja",17],["RTP Açores",18],["RTP Madeira",19],
  ["Sport TV+",20],["Sport TV 1",21],["Sport TV1",21],["Sport TV 2",22],["Sport TV2",22],["Sport TV 3",23],["Sport TV3",23],["Sport TV 4",24],["Sport TV4",24],["Sport TV 5",25],["Sport TV5",25],
  ["BTV",31],["Benfica TV",31],["DAZN 1",33],["Eleven Sports 1",33],["DAZN 2",34],["Eleven Sports 2",34],["DAZN 3",35],["Eleven Sports 3",35],
  ["DAZN 4",36],["Eleven Sports 4",36],["DAZN 5",37],["Eleven Sports 5",37],["Sporting TV",38],["W-Sport",39],["Eurosport 1",40],["Eurosport 2",41],
  ["Disney Channel",50],["Cartoon Network",51],["Panda Kids",52],["SIC K",53],["Nickelodeon",54],["Disney Junior",55],["Panda",56],["Cartoonito",57],["Nick Jr.",58],["Baby TV",59],
  ["Cinemundo",70],["Hollywood",71],["STAR Movies",72],["AMC",73],["AXN Movies",74],["STAR Channel",80],["STAR Life",81],["STAR Crime",82],["AXN",84],["AXN White",85],["Syfy",86],
  ["Discovery Channel",100],["História",101],["Canal História",101],["Odisseia",102],["National Geographic",105],["National Geographic Wild",106],["RTP Memória",110],["SIC Radical",115],["MTV Portugal",116],
].map(([name, number]) => ({ name, number }));

// There is no universal US cable numbering. DIRECTV is the national baseline;
// these are New York local virtual-channel anchors for the local stations that
// occur in the DLHD catalogue.
const US_NYC_LOCALS = [
  ["CBSNY",2],["CBS NY",2],["WCBS",2],["CBS 2 New York",2],
  ["NBCNY",4],["NBC NY",4],["WNBC",4],["NBC 4 New York",4],
  ["FOXNY",5],["FOX NY",5],["WNYW",5],["FOX 5 New York",5],
  ["ABC NY",7],["WABC",7],["ABC 7 New York",7],
  ["MY9TV",9],["WWOR",9],["MY 9",9],
  ["CW PIX 11",11],["WPIX",11],["PIX11",11],
].map(([name, number]) => ({ name, number }));

async function readCache() {
  try {
    const parsed = JSON.parse(await fsp.readFile(CACHE_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function writeCache(cache) {
  try {
    await fsp.mkdir(config.dataDir, { recursive: true });
    await fsp.writeFile(CACHE_FILE, `${JSON.stringify(cache, null, 2)}\n`);
  } catch (error) {
    console.warn("Provider-order cache write failed:", error.message);
  }
}

async function fetchRemoteLineup(country, definition) {
  const response = await fetch(definition.url, {
    signal: AbortSignal.timeout(Math.max(1000, Number(config.fetchTimeoutMs || 30000))),
    headers: { "user-agent": "JustOne Catalog provider-order/1.0", accept: "application/json" },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  const payload = await response.json();
  const entries = flattenLineup(payload);
  if (!entries.length) throw new Error(`${country} provider lineup returned no channels`);
  return {
    provider: definition.provider,
    source: definition.url,
    fetchedAt: new Date().toISOString(),
    entries,
  };
}

function makeIndex(country, remote) {
  const index = new Map();
  if (remote?.entries?.length) addRows(index, remote.entries, remote.provider, "provider-lineup");
  if (country === "GB") addRows(index, SKY_CURRENT, "Sky Glass / Stream", "official-override");
  if (country === "PT") addRows(index, MEO_PT, "MEO", "official-override");
  if (country === "US") addRows(index, US_NYC_LOCALS, "DIRECTV + NYC locals", "official-override");
  return index;
}

export async function loadProviderOrders() {
  const cache = await readCache();
  const now = Date.now();
  const nextCache = { ...(cache || {}), countries: { ...(cache?.countries || {}) } };

  for (const [country, definition] of Object.entries(REMOTE_LINEUPS)) {
    const cached = cache?.countries?.[country];
    const age = now - Date.parse(cached?.fetchedAt || "");
    if (cached?.entries?.length && Number.isFinite(age) && age <= CACHE_TTL_MS) continue;
    try {
      nextCache.countries[country] = await fetchRemoteLineup(country, definition);
    } catch (error) {
      console.warn(`Provider ordering ${country}: ${error.message}; ${cached?.entries?.length ? "using cached lineup" : "using built-in fallback"}`);
    }
  }

  if (JSON.stringify(nextCache) !== JSON.stringify(cache || {})) await writeCache(nextCache);

  const countries = {};
  for (const country of ["GB", "PT", "US"]) countries[country] = makeIndex(country, nextCache.countries?.[country]);
  return {
    countries,
    metadata: {
      GB: { provider: "Sky TV UK", source: nextCache.countries?.GB?.source || "built-in Sky 2026 positions" },
      PT: { provider: "MEO", source: "MEO published channel grid" },
      US: { provider: "DIRECTV Premier + NYC locals", source: nextCache.countries?.US?.source || "built-in NYC local anchors" },
    },
  };
}

export function providerOrderForChannel(channel, providerOrders) {
  const country = String(channel?.group || "").match(/TV\s*\|\s*(UK|GB|PT|USA|US)\b/i)?.[1]?.toUpperCase();
  const cc = country === "UK" ? "GB" : country === "USA" ? "US" : country;
  const index = providerOrders?.countries?.[cc];
  if (!index) return null;

  let best = null;
  for (const value of [channel?.name, ...(channel?.aliasNames || [])]) {
    for (const k of keyVariants(value)) {
      const hit = index.get(k);
      if (!hit) continue;
      if (!best || hit.position < best.position) best = hit;
    }
  }
  return best ? { ...best, country: cc } : null;
}

export { key as providerOrderKey };
