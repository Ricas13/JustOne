const PRIORITY_COUNTRIES = ["US", "GB", "PT"];
const SPECIAL_NAMES = new Map([
  ["US", "USA"],
  ["GB", "UK"],
  ["PT", "Portugal"],
]);

const displayNames = typeof Intl.DisplayNames === "function"
  ? new Intl.DisplayNames(["en"], { type: "region" })
  : null;

export function countryLabel(code) {
  const cc = String(code || "").trim().toUpperCase();
  if (!cc) return "International";
  if (SPECIAL_NAMES.has(cc)) return SPECIAL_NAMES.get(cc);
  try {
    return displayNames?.of(cc) || cc;
  } catch {
    return cc;
  }
}

function countryRank(code) {
  const cc = String(code || "").toUpperCase();
  const preferred = PRIORITY_COUNTRIES.indexOf(cc);
  return preferred >= 0 ? preferred : 100;
}

export function organizeLineup(lineup) {
  const sports = (lineup || [])
    .filter((ch) => ch.kind === "sport-slot")
    .sort((a, b) => Number(a.number || 0) - Number(b.number || 0) || String(a.name).localeCompare(String(b.name)));

  const statics = (lineup || []).filter((ch) => ch.kind === "static");
  const countries = [...new Set(statics.map((ch) => String(ch.country || "").toUpperCase()))]
    .sort((a, b) => {
      const ra = countryRank(a);
      const rb = countryRank(b);
      if (ra !== rb) return ra - rb;
      if (!a) return 1;
      if (!b) return -1;
      return countryLabel(a).localeCompare(countryLabel(b));
    });

  const ordered = [];
  countries.forEach((country, countryIndex) => {
    const rows = statics
      .filter((ch) => String(ch.country || "").toUpperCase() === country)
      .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
    const base = (countryIndex + 1) * 1000;
    rows.forEach((ch, i) => {
      ordered.push({
        ...ch,
        group: countryLabel(country),
        number: base + i,
      });
    });
  });

  return [...sports, ...ordered];
}
