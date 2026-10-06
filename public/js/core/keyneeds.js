// What the site needs from your Torn key, in one place. The "Make my Torn key" link in Settings is built from this
// list, and "Check my key" compares your key against it. Names are Torn's API v2 selection names.

export const NEEDS = [
  { feature: "Bazaar finder (status and account age of sellers)", need: { user: ["profile"] } },
  { feature: "Your own battle stats (Settings)", need: { user: ["battlestats"] } },
  { feature: "Leaderboard (checking your mugs)", need: { user: ["basic", "attacks"], torn: ["attacklog"] } },
  { feature: "Inactive earners (companies, employees, net worth)", need: { torn: ["companies"], company: ["companies", "employees"], user: ["profile", "personalstats"] } },
  { feature: "Bonus weapon sellers (status and account age)", need: { user: ["profile"] } },
];

// The link that opens Torn's "make a key" page with every selection above ticked.
export function keyLink() {
  const all = {};
  for (const { need } of NEEDS) for (const [section, names] of Object.entries(need)) all[section] = [...new Set([...(all[section] || []), ...names])];
  // keep the user selections in a readable order
  const order = ["basic", "profile", "battlestats", "attacks", "personalstats"];
  if (all.user) all.user.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const parts = Object.entries(all).map(([section, names]) => `${section}=${names.join(",")}`);
  return `https://www.torn.com/preferences.php#tab=api?step=addNewKey&title=ClubsDeuceMugger&${parts.join("&")}`;
}

// For a key's selections ({ user: [...], company: [...], torn: [...] }): each feature with what it is missing.
export function checkKey(selections) {
  return NEEDS.map(({ feature, need }) => {
    const missing = [];
    for (const [section, names] of Object.entries(need)) for (const n of names) if (!(selections[section] || []).includes(n)) missing.push(`${section}: ${n}`);
    return { feature, missing };
  });
}
