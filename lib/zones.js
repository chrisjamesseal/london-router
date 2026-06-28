// Curated London station -> TfL fare-zone lookup.
//
// The authoritative source is TfL's own StopPoint data, but it isn't reachable
// from every build environment, so this table is maintained by hand for the core
// network (Underground / DLR / Overground / Elizabeth line / key National Rail).
// Stations not listed here fall back to a distance-from-centre estimate
// (see zoneFor in fares.js). Boundary stations are listed at their inner zone.

// Normalise a station name so "Oxford Circus Underground Station",
// "Oxford Circus" and "OXFORD CIRCUS" all collapse to "oxford circus".
export function normStation(name) {
  return (name || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/['’.]/g, "")
    .replace(/\((?:[^)]*)\)/g, " ")
    .replace(/\b(underground|overground|dlr|tram|tube)\b/g, " ")
    .replace(/\b(rail|national rail)\b/g, " ")
    .replace(/\bstation\b/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// name (normalised) -> zone. Grouped by zone for maintainability.
const BY_ZONE = {
  1: [
    "aldgate", "aldgate east", "angel", "baker street", "bank", "barbican", "bayswater",
    "blackfriars", "bond street", "borough", "cannon street", "chancery lane", "charing cross",
    "covent garden", "edgware road", "embankment", "euston", "euston square", "farringdon",
    "goodge street", "great portland street", "gloucester road", "green park", "holborn",
    "hyde park corner", "kings cross st pancras", "kings cross", "knightsbridge", "lambeth north",
    "lancaster gate", "leicester square", "liverpool street", "london bridge", "mansion house",
    "marble arch", "marylebone", "monument", "moorgate", "mornington crescent", "notting hill gate",
    "old street", "oxford circus", "paddington", "piccadilly circus", "pimlico", "queensway",
    "regents park", "russell square", "st jamess park", "st pauls", "sloane square",
    "south kensington", "southwark", "temple", "tottenham court road", "tower hill", "tower gateway",
    "vauxhall", "victoria", "warren street", "waterloo", "westminster", "elephant and castle",
    "earls court", "shoreditch high street",
  ],
  2: [
    "barons court", "brixton", "caledonian road", "camden town", "canada water", "canary wharf",
    "heron quays", "west india quay", "clapham common", "clapham north", "clapham high street",
    "dalston junction", "dalston kingsland", "finsbury park", "fulham broadway", "hammersmith",
    "highbury and islington", "kennington", "kentish town", "kentish town west", "kilburn",
    "kilburn park", "ladbroke grove", "latimer road", "maida vale", "mile end", "oval",
    "parsons green", "putney bridge", "queens park", "royal oak", "shepherds bush",
    "shepherds bush market", "goldhawk road", "st johns wood", "stepney green", "stockwell",
    "swiss cottage", "west brompton", "west hampstead", "westbourne park", "white city",
    "bethnal green", "bow road", "bow church", "shadwell", "wapping", "rotherhithe", "surrey quays",
    "new cross", "new cross gate", "finchley road", "finchley road and frognal", "brondesbury",
    "brondesbury park", "west kensington", "haggerston", "hoxton", "homerton", "hackney central",
    "hackney downs", "gospel oak", "south hampstead", "kensington olympia", "imperial wharf",
    "wandsworth road", "denmark hill", "peckham rye", "queens road peckham", "nunhead",
    "turnham green", "stamford brook", "ravenscourt park", "hampstead", "manor house",
    "all saints", "devons road", "langdon park", "pudding mill lane", "hackney wick", "star lane",
    "limehouse", "westferry", "poplar", "blackwall", "south quay", "crossharbour", "mudchute",
    "island gardens", "cutty sark", "greenwich", "deptford bridge", "elverson road",
    "willesden junction", "upper holloway",
  ],
  3: [
    "archway", "tufnell park", "highgate", "east finchley", "golders green", "brent cross",
    "turnpike lane", "wood green", "bounds green", "seven sisters", "tottenham hale",
    "blackhorse road", "walthamstow central", "leyton", "leytonstone", "stratford",
    "stratford international", "west ham", "plaistow", "upton park", "bromley by bow", "harlesden",
    "stonebridge park", "north acton", "east acton", "hanger lane", "acton town", "chiswick park",
    "gunnersbury", "ealing broadway", "ealing common", "south ealing", "northfields",
    "south wimbledon", "colliers wood", "tooting broadway", "tooting bec", "balham", "clapham south",
    "willesden green", "dollis hill", "neasden", "kew gardens", "lewisham", "lee", "hither green",
    "catford", "crystal palace", "sydenham", "forest hill", "honor oak park", "brockley",
    "alexandra palace", "abbey road", "west silvertown", "pontoon dock", "london city airport",
    "royal victoria", "custom house", "prince regent", "canning town",
  ],
  // Zones 4+ are mostly left to the distance-from-centre estimate (zoneFor) to
  // avoid shipping mis-remembered assignments — only high-confidence, common
  // outer stations are pinned here.
  4: ["wembley park", "richmond", "morden", "barking", "woolwich arsenal", "woolwich", "abbey wood"],
  5: ["cockfosters", "edgware", "high barnet", "stanmore", "hounslow west", "hounslow central", "hounslow east"],
  6: [
    "heathrow terminals 2 3", "heathrow terminal 4", "heathrow terminal 5", "hatton cross",
    "uxbridge", "upminster", "epping",
  ],
};

export const STATION_ZONES = (() => {
  const m = Object.create(null);
  for (const z of Object.keys(BY_ZONE)) for (const n of BY_ZONE[z]) m[n] = +z;
  return m;
})();

// Look up a station's zone by name; null if not in the curated table.
export function zoneForName(name) {
  const z = STATION_ZONES[normStation(name)];
  return z || null;
}
