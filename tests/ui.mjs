// Browser test: the real pages in a real browser, against the fake services.
// Needs Playwright (not part of the project). Point at it if it is not installed normally:
//
//   PLAYWRIGHT=/path/to/playwright/index.mjs CHROMIUM=/path/to/chromium WRANGLER=... node tests/ui.mjs

import { BASE, OWNER, check, fail, finish, section, setFakeFlag, setFakeStatus, startEnvironment } from "./lib/harness.mjs";

const playwright = await import(process.env.PLAYWRIGHT || "playwright");
const chromium = playwright.chromium || playwright.default.chromium;

async function runChecks() {
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 400, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/ERR_CERT|Failed to load resource/.test(m.text())) errors.push(m.text()); });

  const text = (sel) => page.textContent(sel);
  const setStore = (key, value) => page.evaluate(([k, v]) => localStorage.setItem(k, JSON.stringify(v)), [key, value]);
  const cards = (sel) => page.$$eval(`${sel} .target`, (els) => els.map((e) => ({
    name: e.querySelector(".name").textContent,
    stats: [...e.querySelectorAll("dt")].map((d, i) => [d.textContent, e.querySelectorAll("dd")[i].textContent]).find(([k]) => k === "Est. stats")?.[1],
  })));
  const itemCount = (name) => page.evaluate((n) => {
    const card = [...document.querySelectorAll("#results .target")].find((c) => c.querySelector(".name").textContent === n);
    return card ? card.querySelectorAll(".items li").length : -1;
  }, name);
  const scanDone = () => page.waitForSelector("#scan:not([disabled])", { timeout: 60000 });

  section("Public pages");
  await page.goto(BASE + "/");
  check("sign-in page shows", (await text("h1")).includes("Clubs Deuce Mugger"));
  check("apply form hidden without an invite", await page.isHidden("#apply-form"));
  await page.goto(BASE + "/?invite=abcdefghijklmnopqrstuvwxyz");
  check("apply form shows with an invite", await page.isVisible("#apply-form"));
  await page.goto(BASE + "/recover.html");
  check("recover page shows", await page.isVisible("#recover-form"));
  await page.goto(BASE + "/reset.html?t=x");
  check("reset page shows", await page.isVisible("#reset-form"));

  section("Sign in");
  await page.goto(BASE + "/");
  await page.fill("#login-form [name=username]", OWNER.name);
  await page.fill("#login-form [name=password]", "wrong-password");
  await page.click("#login-form button");
  await page.waitForFunction(() => document.getElementById("login-msg").textContent.includes("Wrong username or password"));
  check("wrong password message", true);
  await page.fill("#login-form [name=password]", OWNER.pass);
  await page.click("#login-form button");
  await page.waitForURL("**/app/");
  check("signed in and sent to the Mug Finder", true);
  check("owner panel built for the owner", await page.waitForSelector("#admin", { timeout: 5000 }).then(() => true, () => false));

  section("Hunt screen");
  check("three basic controls are visible", (await page.isVisible("#minPrice")) && (await page.isVisible("#maxBs")) && (await page.isVisible("#minActivity")));
  check("other controls are folded away", (await page.isHidden("#maxFf")) && (await page.isHidden("#maxSellers")));
  await page.click("details.more > summary");
  check("More options opens", (await page.isVisible("#maxFf")) && (await page.isVisible("#watch-form")));
  await page.click("details.more > summary");
  check("one sort menu", (await page.$$("#sort option")).length === 9 && (await page.$("#dir")) === null);

  section("Scan");
  const filters = { minPrice: 15000000, priceTol: 100, maxItems: 5, autoScan: true, maxSellers: 20, historyTop: 0 };
  await page.evaluate(() => localStorage.clear());
  await setStore("cdm.keys", { torn: "abcdefgh12345678", ff: "" });
  await setStore("cdm.filters", filters);
  await setStore("cdm.prefs", { notify: true, minJackpot: 10000000, myBs: 50e9, outMinutes: 5, offlineMinutes: 35 });
  await page.reload();
  await page.click("#scan");
  await scanDone();
  check("scan finishes", (await text("#scan-msg")).startsWith("Done."), await text("#scan-msg"));
  check("progress bar fills completely", (await page.$eval("#bar", (b) => b.style.width)) === "100%");
  const found = await cards("#results");
  check("all three sellers listed", found.length === 3, JSON.stringify(found));
  check("one card per seller lists all their items", (await itemCount("Alpha")) === 2 && (await itemCount("Bravo")) === 1, `${await itemCount("Alpha")}`);
  check("cards show the estimated stats", found.every((c) => c.stats === "2b"), JSON.stringify(found));
  check("each item shows its trade activity", await page.$$eval("#results .items .meta", (m) => m.length > 0 && m.every((x) => /\/hr/.test(x.textContent))));
  check("jackpot alert at the top", await page.waitForSelector("#alerts .alert", { timeout: 3000 }).then(() => true, () => false));

  section("Filters explain empty results");
  await setStore("cdm.filters", { ...filters, maxBs: 100 });
  await page.reload();
  await page.click("#scan");
  await scanDone();
  check("empty result says why", /are over your max stats/.test(await text("#scan-msg")), await text("#scan-msg"));

  section("Attack taps");
  await page.context().route("https://www.torn.com/**", (route) => route.abort());
  page.context().on("page", (p) => p.close().catch(() => {})); // Torn opens in a new tab; not needed here
  await setStore("cdm.filters", filters);
  await page.reload();
  await page.click("#scan");
  await scanDone();
  check("the Attack button opens Torn's current attack page (page.php, not the retired loader.php)", /^https:\/\/www\.torn\.com\/page\.php\?sid=attack&user2ID=\d+$/.test(await page.getAttribute("#results .target a:has-text('Attack')", "href")));
  await page.evaluate(() => localStorage.removeItem("cdm.taps"));
  await page.click("#results .target a:has-text('Attack')");
  const taps = await page.evaluate(() => JSON.parse(localStorage.getItem("cdm.taps") || "[]"));
  check("tapping Attack saves the tap on the phone", taps.length === 1 && Number.isInteger(taps[0].target) && taps[0].at > 1e9, JSON.stringify(taps));

  section("Stacks");
  const names = async () => (await cards("#results")).map((c) => c.name).sort().join();
  // Singles only, $20m minimum: Gold Bar's cheapest listing is $19.5m, so it is skipped. Silver Bar counts.
  await setStore("cdm.filters", { ...filters, minPrice: 20000000 });
  await page.reload();
  await page.click("#scan");
  await scanDone();
  check("without a stack worth, only items at the minimum count", (await names()) === "Alpha,Charlie" && (await itemCount("Alpha")) === 1, await names());
  // With a stack worth of $30m: Alpha's $39m stacks and Delta's $40m stack of cheaper Emeralds join in.
  await setStore("cdm.filters", { ...filters, minPrice: 20000000, minStack: 30000000 });
  await page.reload();
  await page.click("#scan");
  await scanDone();
  check("stacks worth enough are included", (await names()) === "Alpha,Bravo,Charlie,Delta", await names());
  check("a seller's singles and stacks share one card", (await itemCount("Alpha")) === 2, `${await itemCount("Alpha")}`);
  check("small stacks and single cheap items are left out", !(await names()).includes("Echo") && !(await names()).includes("Foxtrot"));

  section("Added-up items and profit");
  // Emeralds are $8m each. With a $16m minimum and "add up items worth $8m+", Foxtrot's two ($16m) and Delta's five count; Echo's one does not.
  await setStore("cdm.filters", { ...filters, minPrice: 16000000, minPart: 8000000 });
  await page.reload();
  await page.click("#scan");
  await scanDone();
  check("items added up reach the minimum price", (await names()).includes("Foxtrot") && (await names()).includes("Delta") && !(await names()).includes("Echo"), await names());
  const profitText = async () => page.$$eval("#results .target", (cs) => cs.map((c) => c.textContent).join("|"));
  check("cards show expected profit and a rating", /Expected profit/.test(await profitText()) && /(good|mediocre|bad) mug/.test(await profitText()));
  check("bazaar cards show whether the seller was mugged recently", /Recently muggednone known/.test(await profitText()), (await profitText()).slice(0, 200));
  // Foxtrot: $16m at market, so profit is the mug alone: 16m x 5% = +$800k (good). Merits + 20% plunder: 5% x 1.3 = 6.5% = +$1.04m.
  const foxtrot = async () => page.$$eval("#results .target", (cs) => (cs.find((c) => c.textContent.includes("Foxtrot")) || {}).textContent || "");
  check("expected profit at base rate", /\+\$800k/.test(await foxtrot()), await foxtrot());
  // merits and Plunder now live in Settings (2 merits x 5% + 20% Plunder = 1.3x)
  await page.evaluate(() => localStorage.setItem("cdm.prefs", JSON.stringify({ merits: 2, plunder: 20 })));
  await page.reload();
  await page.click("#scan");
  await scanDone();
  check("merits and plunder from Settings raise the expected profit", /\+\$1\.04m/.test(await foxtrot()), await foxtrot());
  await page.evaluate(() => localStorage.removeItem("cdm.prefs")); // back to no bonuses for the tests that follow
  await setStore("cdm.filters", filters);
  await page.reload();

  section("New bazaars each scan");
  // Three items qualify but only one is read per scan: each scan takes the next item, then it wraps round.
  await page.goto(BASE + "/app/");
  await page.waitForFunction(() => document.getElementById("maxBs").value !== "");
  await page.evaluate(() => localStorage.removeItem("cdm.cursor"));
  await setStore("cdm.filters", { ...filters, minPrice: 8000000, maxItems: 1 });
  await page.reload();
  const rotated = [];
  for (let i = 0; i < 4; i++) {
    await page.click("#scan");
    await scanDone();
    rotated.push((await names()));
  }
  check("each scan reads the next item's bazaars", rotated[0] === "Alpha,Charlie" && rotated[1] === "Alpha,Bravo" && rotated[2] === "Delta,Echo,Foxtrot", rotated.join(" | "));
  check("after the last item it wraps round to the first", rotated[3] === rotated[0], rotated.join(" | "));
  check("the message says which items were read", /Read items 1 to 1 of 3/.test(await text("#scan-msg")) || /Read items/.test(await text("#scan-msg")), await text("#scan-msg"));
  await setStore("cdm.filters", filters);
  await page.evaluate(() => localStorage.removeItem("cdm.cursor"));

  section("Trade activity");
  // Gold Bar changed a minute ago (busy), Silver Bar has been quiet for two days. Busiest first:
  await setStore("cdm.filters", { ...filters, sort: "activity", dir: "desc" });
  await page.reload();
  await page.click("#scan");
  await scanDone();
  const byActivity = (await cards("#results")).map((c) => c.name);
  check("sort by trade activity puts the busy item first", byActivity.slice(0, 2).sort().join() === "Alpha,Bravo" && byActivity[2] === "Charlie", byActivity.join());
  await setStore("cdm.filters", { ...filters, minActivity: 5 });
  await page.reload();
  await page.click("#scan");
  await scanDone();
  const busyOnly = (await cards("#results")).map((c) => c.name).sort();
  check("minimum activity hides quiet items", busyOnly.join() === "Alpha,Bravo", busyOnly.join());

  section("Live status updates");
  // Statuses must catch up on their own, without a new scan.
  const statusOf = (name) => page.evaluate((n) => {
    const card = [...document.querySelectorAll("#results .target")].find((c) => c.querySelector(".name").textContent === n);
    return card ? card.querySelector(".status").textContent : null;
  }, name);
  await setStore("cdm.filters", filters);
  await page.reload();
  await page.click("#scan");
  await scanDone();
  check("Alpha starts out okay", (await statusOf("Alpha")) === "Okay", await statusOf("Alpha"));
  await setFakeStatus(7, "Hospital", 30);
  check("Alpha is caught going to hospital without a new scan",
    await page.waitForFunction(() => [...document.querySelectorAll("#results .target")].some((c) => c.querySelector(".name").textContent === "Alpha" && /^Out in/.test(c.querySelector(".status").textContent)), null, { timeout: 45000 }).then(() => true, () => false),
    await statusOf("Alpha"));
  await setFakeStatus(8, "Abroad");
  check("Bravo flying abroad shows Abroad, not Okay",
    await page.waitForFunction(() => [...document.querySelectorAll("#results .target")].some((c) => c.querySelector(".name").textContent === "Bravo" && c.querySelector(".status").textContent === "Abroad"), null, { timeout: 45000 }).then(() => true, () => false),
    await statusOf("Bravo"));
  check("cards show when they were last checked", (await page.$$eval("#results .ago[data-kind=checked]", (els) => els.every((e) => /s ago|m ago|just now/.test(e.textContent)))));
  await setFakeStatus(7, "Okay");
  await setFakeStatus(8, "Okay");

  section("Only players who are Okay");
  await setStore("cdm.filters", filters);
  await page.reload();
  await page.click("#scan");
  await scanDone();
  check("all three are shown at first", (await cards("#results")).length === 3);
  await setFakeStatus(7, "Hospital", 30);
  await page.waitForFunction(() => [...document.querySelectorAll("#results .target")].some((c) => c.querySelector(".name").textContent === "Alpha" && /^Out in/.test(c.querySelector(".status").textContent)), null, { timeout: 45000 });
  await page.click("details.more > summary");
  await page.check("#onlyOkay");
  check("ticking it hides a player who is in hospital", (await names()) === "Bravo,Charlie", await names());
  await setFakeStatus(7, "Okay");
  await setFakeStatus(8, "Abroad");
  await page.waitForFunction(() => document.querySelectorAll("#results .target").length === 1, null, { timeout: 45000 }).catch(() => {});
  check("a player who flies away disappears on their own", !(await names()).includes("Bravo"), await names());
  await page.uncheck("#onlyOkay");
  check("unticking brings them back", (await cards("#results")).length === 3);
  await page.click("details.more > summary");
  await setFakeStatus(8, "Okay");

  section("Auto hunt, feed and cancel");
  await setStore("cdm.filters", { ...filters, autoEvery: 30 });
  await page.reload();
  await page.click("#auto");
  await page.waitForSelector("#feed:not([hidden])", { timeout: 60000 });
  check("good mugs land in the feed", (await cards("#feed-list")).length === 3);
  check("tab title shows the count", (await page.title()).startsWith("(3)"));
  // a mug that stops qualifying leaves the feed by itself
  await setFakeStatus(7, "Hospital", 30);
  check("a mug that goes to hospital leaves the feed",
    await page.waitForFunction(() => document.querySelectorAll("#feed-list .target").length === 2, null, { timeout: 60000 }).then(() => true, () => false));
  await setFakeStatus(7, "Okay");
  await page.click("#feed-list .x");
  check("X dismisses one", (await cards("#feed-list")).length === 1);
  await page.click("#feed-dismiss-all");
  check("Dismiss all clears the feed", await page.isHidden("#feed"));
  check("cancel button visible while hunting", await page.isVisible("#cancel"));
  await page.click("#cancel");
  check("cancel stops auto hunt", (await text("#auto")) === "Start auto hunt" && (await text("#scan-msg")) === "Scan cancelled.");

  section("Settings");
  await page.goto(BASE + "/app/settings.html");
  check("settings page loads", await page.isVisible("#save-keys"));
  check("saved key shown", (await page.inputValue("#key-torn")) === "abcdefgh12345678");
  check("no TornStats box", (await page.$("#key-ts")) === null);

  section("Key on the account");
  check("password box hidden until the box is ticked", await page.isHidden("#pass-row"));
  await page.check("#save-account");
  check("password box appears", await page.isVisible("#pass-row"));
  await page.click("#save-keys");
  check("password is asked for", /password/i.test(await text("#keys-msg")), await text("#keys-msg"));
  await page.fill("#key-pass", "wrong-password");
  await page.click("#save-keys");
  await page.waitForFunction(() => /Wrong password/.test(document.getElementById("keys-msg").textContent));
  check("wrong password is explained", true);
  await page.fill("#key-pass", OWNER.pass);
  await page.click("#save-keys");
  await page.waitForFunction(() => /on your account/.test(document.getElementById("keys-msg").textContent));
  check("key saved on the account", true);
  // like a new phone: nothing stored in this browser
  await page.evaluate(() => localStorage.removeItem("cdm.keys"));
  await page.goto(BASE + "/app/settings.html");
  await page.waitForFunction(() => document.getElementById("key-torn").value !== "");
  check("key comes back from the account", (await page.inputValue("#key-torn")) === "abcdefgh12345678" && /Loaded your saved key/.test(await text("#keys-msg")));
  check("box is ticked again", await page.isChecked("#save-account"));
  await page.click("#make-invite");
  await page.waitForSelector("#invite-box:not([hidden])");
  check("invite link made, with Copy and Share", (await text("#invite-link")).includes("?invite=") && (await page.isVisible("#invite-copy")));
  await page.click("#invite-list .x-btn");
  await page.waitForFunction(() => document.getElementById("invite-box").hidden || document.getElementById("invite-list").children.length === 0);
  check("X closes the invite", true);
  check("FF Scouter section is folded away", await page.isHidden("#test-ff"));
  await page.click("details.more > summary");
  await page.click("#test-ff");
  await page.waitForFunction(() => document.getElementById("keys-msg").textContent.length > 12);
  check("FF Scouter key test answers", /FF Scouter/.test(await text("#keys-msg")), await text("#keys-msg"));

  section("Mug tracking");
  // A tap carries a prediction; the page checks your attack log by itself (every minute, shortened here) and matches it.
  await page.goto(BASE + "/app/");
  await page.waitForFunction(() => document.getElementById("maxBs").value !== "");
  await setStore("cdm.keys", { torn: "abcdefgh12345678", ff: "" });
  await page.evaluate(() => {
    localStorage.setItem("cdm.watchMs", "1000");
    localStorage.setItem("cdm.taps", JSON.stringify([{ target: 111, at: Math.floor(Date.now() / 1000), pred: { src: "earners", mug: 5000000, cash: 90000000, networth: 2500000000, score: 70, recent: 2, hosp: false } }]));
  });
  await page.reload();
  const matchedByWatch = await page.waitForFunction(async () => (await (await fetch("/api/mug/outcomes")).json()).rows.some((o) => o.target_id === 111 && o.result === "Mugged"), null, { timeout: 40000, polling: 1000 }).then(() => true, () => false);
  check("the watch matched the mug by itself, with no button pressed", matchedByWatch);
  await page.evaluate(() => localStorage.removeItem("cdm.watchMs"));
  await page.goto(BASE + "/app/leaderboard.html");
  await page.waitForSelector("#outcomes .item");
  const outcomeText = await text("#outcomes");
  check("the outcome compares what was predicted with what was mugged, and says why it was lower", /Below prediction/.test(outcomeText) && /\$2,500,000 of \$5,000,000/.test(outcomeText) && /2 recent mugs/.test(outcomeText), outcomeText.slice(0, 300));
  check("the summary says how close predictions are", /took 50% of its prediction/.test(await text("#outcome-summary")), await text("#outcome-summary"));
  // A key without the attacks permission: the check says what is missing and links to a new key.
  await page.evaluate(() => fetch("/api/clicks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ target: 5000 }) }));
  await setFakeFlag("attacksDenied", true);
  await setFakeFlag("keyLimited", true);
  await page.click("#sync");
  await page.waitForSelector("#sync-diag li");
  check("a key without the attacks permission is explained on the leaderboard page", /Torn key problem/.test(await text("#sync-msg")) && /Missing: Leaderboard[^\n]*attacks/.test(await text("#sync-diag")) && (await page.$("#sync-diag a")) !== null, `${await text("#sync-msg")} | ${await text("#sync-diag")}`);
  await setFakeFlag("attacksDenied", false);
  await setFakeFlag("keyLimited", false);

  section("Inactive earners");
  await page.evaluate(() => localStorage.setItem("cdm.prefs", JSON.stringify({ hideMuggedHours: 0 }))); // show everyone while these tests run
  const earnCards = () => page.$$eval("#results .target", (els) => els.map((e) => ({
    name: e.querySelector(".name").textContent,
    text: e.textContent,
    link: [...e.querySelectorAll("a")].map((a) => a.textContent).join(),
  })));
  await page.goto(BASE + "/app/");
  await setStore("cdm.keys", { torn: "abcdefgh12345678", ff: "" });
  await page.evaluate(() => { localStorage.removeItem("cdm.earn.filters"); localStorage.removeItem("cdm.earn.wages"); localStorage.removeItem("cdm.earn.cache"); });
  check("the bazaar page has the finder tabs", (await page.$$("nav.tabs a")).length === 3);
  await page.goto(BASE + "/app/earners.html");
  await page.waitForSelector("#types label");
  check("company types listed, Mining ticked the first time", (await page.$$("#types label")).length === 2 && (await page.isChecked("#types label:first-child input")));
  check("the best earning types are marked [ Suggested ] and listed first", /Mining Corporation\s*\[ Suggested \]/.test(await text("#types label:first-child")) && !/Suggested/.test(await text("#types label:last-child")), await text("#types"));
  // A failed load is explained inside the list, and Try again works.
  await setFakeFlag("typesFail", true);
  await page.evaluate(() => localStorage.removeItem("cdm.earn.cache"));
  await page.reload();
  await page.waitForSelector("#types .msg.err");
  check("a failed list says why, how to fix a key without company access, and offers Try again", /Access level of this key is not high enough/.test(await text("#types")) && /make a new key/.test(await text("#types")) && (await page.isVisible("#types button")), await text("#types"));
  await setFakeFlag("typesFail", false);
  await page.click("#types button");
  await page.waitForSelector("#types label");
  check("Try again loads the list", (await page.$$("#types label")).length === 2);
  // the attack history reads are tested on their own below; keep these scans to the basic calls
  await setStore("cdm.earn.filters", { historyTop: 0, types: [12], minStars: 5, minDays: 7 });
  await page.goto(BASE + "/app/settings.html");
  const keyLink = await page.getAttribute("#make-key", "href");
  check("the key made from Settings asks for everything the site uses", /company=[^&]*employees/.test(keyLink) && /torn=[^&]*companies/.test(keyLink) && /torn=[^&]*attacklog/.test(keyLink) && /user=[^&]*personalstats/.test(keyLink) && /user=basic,profile,battlestats,attacks/.test(keyLink), keyLink);
  check("a Limited Access key link is offered too", /type=3/.test(await page.getAttribute("#make-key-limited", "href")));
  await page.click("#check-key");
  await page.waitForSelector("#keycheck-list li");
  check("Check my key says a full key covers everything", /covers everything the site needs/.test(await text("#keycheck-msg")) && !/Missing/.test(await text("#keycheck-list")), await text("#keycheck-msg"));
  await setFakeFlag("keyLimited", true);
  await page.click("#check-key");
  await page.waitForFunction(() => /missing access/.test(document.getElementById("keycheck-msg").textContent));
  check("Check my key names the features a limited key cannot do", /Missing: Leaderboard[^\n]*attacks/.test(await text("#keycheck-list")) && /Missing: Inactive earners/.test(await text("#keycheck-list")), await text("#keycheck-list"));
  await setFakeFlag("keyLimited", false);
  await page.goto(BASE + "/app/earners.html");
  await page.waitForSelector("#types label");
  await page.click("#scan");
  await scanDone();
  let efound = await earnCards();
  const rex = efound.find((c) => c.name === "Rex"), pia = efound.find((c) => c.name === "Pia");
  check("only inactive players at companies with enough stars", efound.map((c) => c.name).sort().join() === "Pia,Rex", efound.map((c) => c.name).join());
  check("estimated cash: 60% of $1m daily income / 3 employees = $200k a day x days inactive, labelled rough", /~\$6m \(rough\)/.test(rex.text) && /~\$2m \(rough\)/.test(pia.text), efound.map((c) => c.text.slice(0, 120)).join(" | "));
  check("cards show company, type, stars, position, profile and attack buttons", /Deep Co · Mining Corporation · 10★/.test(rex.text) && /Miner/.test(rex.text) && rex.link === "Profile,Attack", efound[0].link);
  check("cards show stats, fair fight, age and status", /Est\. stats2b/.test(rex.text) && /Fair fight1\.50/.test(rex.text) && /Account age\d+ days/.test(rex.text) && /Status(Okay|Out|Hospital)/.test(rex.text), rex.text);
  check("mug rating and predicted mug shown", /Mug rating(Excellent|Good|Fair|Poor) \(\d+\/100\)/.test(rex.text) && /Predicted mug~\$(20[5-9]|21[0-4])k \(rough\)/.test(rex.text), rex.text.slice(0, 220));
  check("net worth shown and counted in the rating", /Net worth\$2\.3b/.test(rex.text), rex.text.slice(0, 220));
  check("a player mugged 9 hours ago is marked and rated lower (the yield is back to about 70%)", /Recently mugged1 mug in 24h \(last 9h ago\) \(-30%\)/.test(rex.text), rex.text.slice(0, 320));
  const rec = await page.evaluate(async () => { const m = await import("/app/js/earners/rules.js"); return [m.recovery(0), m.recovery(8), m.recovery(9), m.recovery(10), m.recovery(15), m.recovery(40)]; });
  check("mug yield recovers over 15 hours (about 65% at 8h, 70% at 9h, full at 15h)", rec[0] === 0.1 && rec[1] > 0.6 && rec[1] < 0.7 && rec[2] > 0.68 && rec[2] < 0.72 && rec[3] > rec[2] && rec[4] === 1 && rec[5] === 1, JSON.stringify(rec));
  await page.click("#results .target:has-text('Rex') a:has-text('Attack')");
  const lastTap = await page.evaluate(() => JSON.parse(localStorage.getItem("cdm.taps") || "[]").pop());
  check("the Attack tap saves the prediction (mug, cash, net worth, score, recent mugs)", lastTap && lastTap.pred && lastTap.pred.src === "earners" && lastTap.pred.mug > 0 && lastTap.pred.networth === 2300000000 && lastTap.pred.score > 0 && lastTap.pred.recent === 1, JSON.stringify(lastTap));
  check("a player mugged recently is ranked below one who was not (Pia above Rex)", efound[0].name === "Pia", efound.map((c) => c.name).join());
  await page.evaluate(() => localStorage.setItem("cdm.prefs", JSON.stringify({ merits: 2, plunder: 20, hideMuggedHours: 0 })));
  await page.reload();
  await page.waitForSelector("#types label");
  await page.click("#scan");
  await page.waitForSelector("#scan:not([disabled])", { timeout: 120000 });
  check("merits and Plunder from Settings raise the predicted mug", /Predicted mug~\$(26[5-9]|27[0-9])k/.test((await earnCards()).find((c) => c.name === "Rex").text), (await earnCards()).find((c) => c.name === "Rex").text.slice(0, 200));
  await page.evaluate(() => localStorage.setItem("cdm.prefs", JSON.stringify({ hideMuggedHours: 0 })));
  await page.selectOption("#sort", "days:asc");
  check("sorting by days inactive", (await earnCards()).map((c) => c.name).join() === "Pia,Rex");
  // the second scan is served from the browser cache: no new company or employee calls
  const tornCalls = () => page.evaluate(() => JSON.parse(localStorage.getItem("cdm.calls") || "[]").length);
  const before = await tornCalls();
  await page.click("#scan");
  await scanDone();
  const after = await tornCalls();
  check("a repeat scan reuses the cached company data", after - before <= 2, `${after - before} Torn calls`);
  // The days-in-company cap and the other type: Petals (5 stars), Tess idle 15 days but employed 8.
  await setStore("cdm.earn.filters", { historyTop: 0, types: [5], minStars: 5, minDays: 7, sort: "cash", dir: "desc" });
  await page.reload();
  await page.waitForSelector("#types label");
  await page.click("#scan");
  await scanDone();
  efound = await earnCards();
  check("cash is capped by days in the company", efound.length === 1 && efound[0].name === "Tess" && /~\$4\.8m \(rough\)/.test(efound[0].text), efound.map((c) => c.text.slice(0, 100)).join("|"));
  // Settings wages change the estimate.
  await page.goto(BASE + "/app/settings.html");
  await page.waitForSelector("#w-types input", { state: "attached" });
  await page.click("summary:has-text('Wage per company type')");
  await page.fill("#w-share", "60");
  await page.fill("#w-base", "1000000");
  await page.fill("#w-types input[data-type='5']", "2000000");
  await page.click("#save-wages");
  await page.goto(BASE + "/app/earners.html");
  await page.waitForSelector("#types label");
  await page.click("#scan");
  await scanDone();
  efound = await earnCards();
  check("a wage set in Settings changes the estimate", /~\$8m \(rough\)/.test(efound[0].text), efound[0] && efound[0].text.slice(0, 100));
  await setStore("cdm.earn.filters", { historyTop: 0, types: [12], minStars: 5, minDays: 7 });
  await setStore("cdm.earn.wages", { base: 500000, types: {} });

  section("Inactive earners keep searching");
  // 27 companies at 10 stars: the scan goes on batch after batch until it has them all, or has enough.
  await setFakeFlag("manyCompanies", true);
  await page.goto(BASE + "/app/earners.html");
  await page.waitForFunction(() => document.getElementById("maxBs").value !== "");
  await page.evaluate(() => { localStorage.removeItem("cdm.earn.cache"); localStorage.removeItem("cdm.calls"); localStorage.removeItem("cdm.profiles"); });
  await setStore("cdm.earn.filters", { historyTop: 0, types: [12], minStars: 5, minDays: 7, maxPlayers: 80 });
  await page.reload();
  await page.waitForSelector("#types label");
  await page.evaluate(() => localStorage.removeItem("cdm.calls")); // a fresh minute of Torn calls
  await page.click("#scan");
  await page.waitForSelector("#scan:not([disabled])", { timeout: 150000 });
  efound = await earnCards();
  check("it keeps going through every company (more than one batch of ten)", efound.length === 27, `${efound.length} | ${await text("#scan-msg")}`);
  const callsUsed = await page.evaluate(() => JSON.parse(localStorage.getItem("cdm.calls") || "[]").length);
  check("one combined call per match: 26 employee lists + 27 players is about 55 Torn calls, not 80+", callsUsed > 0 && callsUsed <= 62, `${callsUsed} Torn calls`);
  check("the message says how many companies were checked", /after checking 26 of 26 companies|after checking \d+ of \d+ companies/.test(await text("#scan-msg")), await text("#scan-msg"));
  await setStore("cdm.earn.filters", { historyTop: 0, types: [12], minStars: 5, minDays: 7, maxPlayers: 5 });
  await page.reload();
  await page.waitForSelector("#types label");
  await page.evaluate(() => localStorage.removeItem("cdm.calls")); // a fresh minute of Torn calls
  await page.click("#scan");
  await page.waitForSelector("#scan:not([disabled])", { timeout: 150000 });
  efound = await earnCards();
  check("it stops once it has found enough players", efound.length === 5 && /stopped at your limit/.test(await text("#scan-msg")), `${efound.length} | ${await text("#scan-msg")}`);
  await setFakeFlag("manyCompanies", false);
  // A key without personal stats access: the scan falls back to the profile alone and says net worth is missing.
  await setFakeFlag("combinedFail", true);
  await page.evaluate(() => { localStorage.removeItem("cdm.earn.cache"); localStorage.removeItem("cdm.calls"); localStorage.removeItem("cdm.profiles"); });
  await setStore("cdm.earn.filters", { historyTop: 0, types: [12], minStars: 5, minDays: 7 });
  await page.reload();
  await page.waitForSelector("#types label");
  await page.click("#scan");
  await page.waitForSelector("#scan:not([disabled])", { timeout: 120000 });
  efound = await earnCards();
  check("without personal stats access it still finds players with status and age, net worth unknown", efound.length === 2 && /Account age100 days/.test(efound[0].text) && /Net worth\?/.test(efound[0].text) && /Net worth could not be read/.test(await text("#scan-msg")), `${efound.length} | ${await text("#scan-msg")}`);
  await setFakeFlag("combinedFail", false);
  await page.evaluate(() => { localStorage.removeItem("cdm.earn.cache"); localStorage.removeItem("cdm.profiles"); });
  await setStore("cdm.earn.filters", { historyTop: 0, types: [12], minStars: 5, minDays: 7 });

  await setFakeFlag("hotBazaar", true);
  section("Attack history of players");
  // Torn's public stats show attacks by anyone: Rex lost 2 fights as the defender in a day (1 was a member's mug we know of),
  // 5 in a week, and his net worth fell from 2.9b to 2.3b. Pia is quiet.
  await setStore("cdm.earn.filters", { types: [12], minStars: 5, minDays: 7, historyTop: 5 });
  await page.evaluate(() => { localStorage.removeItem("cdm.earn.cache"); localStorage.removeItem("cdm.calls"); localStorage.removeItem("cdm.profiles"); });
  await page.goto(BASE + "/app/earners.html");
  await page.waitForSelector("#types label");
  await page.click("#scan");
  await page.waitForSelector("#scan:not([disabled])", { timeout: 150000 });
  efound = await earnCards();
  const rex2 = efound.find((c) => c.name === "Rex"), pia2 = efound.find((c) => c.name === "Pia");
  check("the bazaar's recent sales are shown from Torn's stats", /5 sales \(\$10\.0m\) in ~24h, 30 \(\$60\.0m\) in ~7 days, about \$2\.0m each/.test(rex2.text), rex2.text.slice(0, 600));
  check("outside attacks are found from Torn's stats and lower the rating", /Torn stats: 2 fights lost in ~24h, 5 in ~7 days \(anyone\)/.test(rex2.text) && /net worth down 21% since yesterday/.test(rex2.text) && /\(-48%\)/.test(rex2.text), rex2.text.slice(0, 420));
  check("the predicted mug shrinks with them (6m wages + 60m bazaar sales, x 5% x 0.52)", /Predicted mug~\$1\.(69|7[0-3])m/.test(rex2.text), rex2.text.slice(0, 200));
  check("a quiet player is not marked", /Recently muggednone known/.test(pia2.text), pia2.text.slice(0, 260));
  // With the attack history off, every match still has its bazaar checked right away (2 Torn calls each).
  await setStore("cdm.earn.filters", { historyTop: 0, types: [12], minStars: 5, minDays: 7 });
  await page.evaluate(() => { localStorage.removeItem("cdm.earn.cache"); localStorage.removeItem("cdm.calls"); localStorage.removeItem("cdm.profiles"); });
  await page.goto(BASE + "/app/earners.html");
  await page.waitForSelector("#types label");
  await page.click("#scan");
  await page.waitForSelector("#scan:not([disabled])", { timeout: 150000 });
  const rex2b = (await earnCards()).find((c) => c.name === "Rex");
  check("every match has its bazaar checked right away, even with the attack history off", /Bazaar sales30 \(\$60\.0m\) in ~7 days, about \$2\.0m each/.test(rex2b.text) && !/Torn stats:/.test(rex2b.text), rex2b.text.slice(0, 500));
  await setFakeFlag("hotBazaar", false);
  await setStore("cdm.earn.filters", { historyTop: 0, types: [12], minStars: 5, minDays: 7 });

  section("Profit tools");
  // Win chance and expected value need your own stats (Settings); the sort can use them.
  await setStore("cdm.earn.filters", { historyTop: 0, types: [12], minStars: 5, minDays: 7 });
  await page.evaluate(() => { localStorage.setItem("cdm.prefs", JSON.stringify({ myBs: 4000000000, hideMuggedHours: 0 })); localStorage.removeItem("cdm.earn.cache"); localStorage.removeItem("cdm.calls"); localStorage.removeItem("cdm.profiles"); });
  await page.goto(BASE + "/app/earners.html");
  await page.waitForSelector("#types label");
  await page.click("#scan");
  await page.waitForSelector("#scan:not([disabled])", { timeout: 150000 });
  efound = await earnCards();
  const rex3 = efound.find((c) => c.name === "Rex");
  check("win chance from their stats against yours, and the expected value", /Win chance~9[12]% \(rough\)/.test(rex3.text) && /Expected value~\$\d+k/.test(rex3.text), rex3.text.slice(0, 260));
  await page.selectOption("#sort", "ev:desc");
  check("sorting by expected value puts the bigger mug first", (await earnCards())[0].name === "Rex", (await earnCards()).map((c) => c.name).join());
  await page.evaluate(() => localStorage.setItem("cdm.prefs", JSON.stringify({ hideMuggedHours: 0 })));
  await page.reload();
  await page.waitForSelector("#types label");
  await page.click("#scan");
  await page.waitForSelector("#scan:not([disabled])", { timeout: 150000 });
  check("without your stats it says so, and the expected value is the mug", /Win chanceset your stats in Settings/.test((await earnCards())[0].text), (await earnCards())[0].text.slice(0, 200));
  // Learning from real mugs: the one matched mug (predicted $5m, took $2.5m) halves later predictions once it counts.
  await page.evaluate(() => localStorage.setItem("cdm.calMin", "1"));
  await page.reload();
  await page.waitForSelector("#types label");
  check("the page says predictions were adjusted from real mugs", /adjusted x0\.50 from your 1 real mug/.test(await text("#calib-note")), await text("#calib-note"));
  await page.click("#scan");
  await page.waitForSelector("#scan:not([disabled])", { timeout: 150000 });
  efound = await earnCards();
  const rex4 = efound.find((c) => c.name === "Rex");
  check("predicted mug is halved (about $105k instead of $210k)", /Predicted mug~\$10[0-9]k/.test(rex4.text), rex4.text.slice(0, 200));
  await page.click("#results .target:has-text('Rex') a:has-text('Attack')");
  const calTap = await page.evaluate(() => JSON.parse(localStorage.getItem("cdm.taps") || "[]").pop());
  check("the tap still saves the plain prediction, so the correction never feeds on itself", calTap && calTap.pred && calTap.pred.mug > 190000, JSON.stringify(calTap));
  await page.evaluate(() => { localStorage.removeItem("cdm.calMin"); localStorage.setItem("cdm.prefs", JSON.stringify({ hideMuggedHours: 0 })); });
  await setStore("cdm.earn.filters", { historyTop: 0, types: [12], minStars: 5, minDays: 7 });

  section("Avoiding mugged players");
  // Rex was mugged 9 hours ago (by a member, in the record). By default players mugged in the last 12 hours are hidden.
  const reScan = async () => { await page.reload(); await page.waitForSelector("#types label"); await page.click("#scan"); await page.waitForSelector("#scan:not([disabled])", { timeout: 150000 }); return (await earnCards()).map((c) => c.name).sort().join(); };
  await setStore("cdm.earn.filters", { historyTop: 0, types: [12], minStars: 5, minDays: 7 });
  await page.evaluate(() => { localStorage.removeItem("cdm.prefs"); localStorage.removeItem("cdm.muggedLocal"); localStorage.removeItem("cdm.earn.cache"); localStorage.removeItem("cdm.calls"); localStorage.removeItem("cdm.profiles"); });
  await page.goto(BASE + "/app/earners.html");
  let shownNames = await reScan();
  check("a player mugged 9 hours ago is hidden by default (the setting is 12 hours) and the page says so", shownNames === "Pia" && /1 hidden: mugged in the last 12 hours/.test(await text("#hidden-note")), `${shownNames} | ${await text("#hidden-note")}`);
  await page.evaluate(() => localStorage.setItem("cdm.prefs", JSON.stringify({ hideMuggedHours: 6 })));
  shownNames = await reScan();
  check("with a 6 hour setting he shows again, with a red edge on the card", shownNames === "Pia,Rex" && (await page.$$("#results .card.recent-mug")).length === 1, shownNames);
  await page.evaluate(() => localStorage.removeItem("cdm.prefs")); // 12 hours again
  shownNames = await reScan();
  await page.click("#results .target:has-text('Pia') button:has-text('Mark mugged')");
  const marked = await page.evaluate(() => JSON.parse(localStorage.getItem("cdm.muggedLocal") || "{}"));
  check("Mark mugged hides the player at once and remembers it", shownNames === "Pia" && marked["21"] > 1e9 && (await page.$$("#results .target")).length === 0 && /Everyone found was mugged lately/.test(await text("#results")), JSON.stringify(marked));
  await page.evaluate(() => localStorage.removeItem("cdm.muggedLocal"));
  // Settings: the hours are saved with the other mugging bonuses
  await page.goto(BASE + "/app/settings.html");
  await page.fill("#m-hide", "3");
  await page.click("#save-mugbonus");
  const savedHide = await page.evaluate(() => JSON.parse(localStorage.getItem("cdm.prefs") || "{}").hideMuggedHours);
  check("the hide setting is saved in Settings", savedHide === 3, String(savedHide));
  await page.evaluate(() => localStorage.setItem("cdm.prefs", JSON.stringify({ hideMuggedHours: 12 })));
  // The bazaar finder: a seller you mark as mugged is hidden, and sellers' recent attacks come from Torn's stats too
  await page.goto(BASE + "/app/");
  await page.waitForFunction(() => document.getElementById("maxBs").value !== "");
  await setStore("cdm.filters", { ...filters, historyTop: 5 });
  await page.reload();
  await page.click("#scan");
  await scanDone();
  const bravo = (await page.$$eval("#results .target", (els) => els.map((e) => e.textContent))).find((t) => t.includes("Bravo")) || "";
  check("bazaar sellers get the attack history too (Bravo lost 2 fights in a day)", /Torn stats: 2 fights lost in ~24h/.test(bravo), bravo.slice(0, 300));
  await page.click("#results .target:has-text('Alpha') button:has-text('Mark mugged')");
  check("a bazaar seller marked as mugged is hidden", !(await names()).includes("Alpha") && /hidden/.test(await text("#hidden-note")), `${await names()} | ${await text("#hidden-note")}`);
  await page.evaluate(() => { localStorage.removeItem("cdm.muggedLocal"); localStorage.setItem("cdm.prefs", JSON.stringify({ hideMuggedHours: 0 })); });
  await setStore("cdm.filters", filters);
  await setStore("cdm.earn.filters", { historyTop: 0, types: [12], minStars: 5, minDays: 7 });

  section("Bonus weapon sellers");
  const bonusCards = () => page.$$eval("#results .target", (els) => els.map((e) => ({
    name: e.querySelector(".name").textContent,
    text: e.textContent,
    links: [...e.querySelectorAll("a")].map((a) => a.textContent).join(),
    rarity: e.querySelector(".sub").className,
  })));
  const scanBonusPage = async () => { await page.click("#scan"); await scanDone(); return bonusCards(); };
  await page.goto(BASE + "/app/bonus.html");
  await page.waitForFunction(() => document.getElementById("maxBs").value !== ""); // the page has started and saved its own filters
  check("three finder tabs on the bonus page", (await page.$$("nav.tabs a")).length === 3 && (await page.$("nav.tabs a[aria-current=page]")) !== null);
  await setStore("cdm.keys", { torn: "abcdefgh12345678", ff: "" });
  await setStore("cdm.bonus.filters", { historyTop: 0, maxBs: 5000000000 });
  await page.reload();
  await page.waitForSelector("#bonuses label");
  let bw = await scanBonusPage();
  check("only bazaar sellers inside the stat range, cheapest first", bw.map((c) => c.name).join() === "Fake Magnum,Fake Katana", bw.map((c) => c.name).join());
  check("cards show bonus, rarity, price, location, stats and seller", /Bloodlust 40%/.test(bw[0].text) && /rarity-yellow/.test(bw[0].rarity) && /\$30,000,000/.test(bw[0].text) && /LocationBazaar/.test(bw[0].text) && /40\.5 \/ 50\.1 \/ 60\.2/.test(bw[0].text) && /Weak \(ID 51\)/.test(bw[0].text) && /Est\. stats2b/.test(bw[0].text), bw[0].text.slice(0, 260));
  check("cards have listing, profile and attack buttons", bw[0].links === "Listing,Profile,Attack", bw[0].links);
  check("the anonymous item market listing is left out", !bw.some((c) => c.name === "Fake Anon"));
  await page.selectOption("#sort", "bonus:desc");
  check("sorting by bonus", (await bonusCards()).map((c) => c.name).join() === "Fake Magnum,Fake Katana");
  await page.selectOption("#sort", "bonus:asc");
  check("sorting by bonus, smallest first", (await bonusCards()).map((c) => c.name).join() === "Fake Katana,Fake Magnum");
  await setStore("cdm.bonus.filters", { historyTop: 0, maxBs: 5000000000, bonuses: ["Expose"] });
  await page.reload();
  await page.waitForSelector("#bonuses label");
  bw = await scanBonusPage();
  check("a bonus choice finds only that bonus", bw.map((c) => c.name).join() === "Fake Katana" && /rarity-red/.test(bw[0].rarity), bw.map((c) => c.name).join());
  await setStore("cdm.bonus.filters", { historyTop: 0, maxBs: 5000000000, rarities: ["yellow"], maxPrice: 50000000 });
  await page.reload();
  await page.waitForSelector("#bonuses label");
  bw = await scanBonusPage();
  check("rarity and price filters", bw.map((c) => c.name).join() === "Fake Magnum", bw.map((c) => c.name).join());
  await setStore("cdm.bonus.filters", {});

  section("Deeper pages and new sellers");
  // Bazaar finder: Big Item has 250 listings over 3 pages. The next page is read while listings are inside the price band.
  await page.goto(BASE + "/app/");
  await page.waitForFunction(() => document.getElementById("maxBs").value !== "");
  await setFakeFlag("deep", true);
  await setStore("cdm.filters", { ...filters, minPrice: 25000000, priceTol: 10, maxItems: 5 });
  await page.reload();
  await page.click("#scan");
  await scanDone();
  check("sellers beyond the first page are found, ones above the price band are not", (await names()) === "PageOne,PageThree,PageTwo", await names());
  await setStore("cdm.filters", { ...filters, minPrice: 25000000, priceTol: 10, maxItems: 5, bazaarPages: 1 });
  await page.reload();
  await page.click("#scan");
  await scanDone();
  check("one page per item reads only the cheapest listings", (await names()) === "PageOne", await names());
  // Bonus weapon sellers: each scan carries on with the next pages of the same search.
  await page.goto(BASE + "/app/bonus.html");
  await page.waitForFunction(() => document.getElementById("maxBs").value !== "");
  await page.evaluate(() => { localStorage.removeItem("cdm.bonus.cursor"); localStorage.removeItem("cdm.bonus.cache"); });
  await setStore("cdm.bonus.filters", { historyTop: 0, maxBs: 5000000000, rarities: ["yellow"], pages: 2 });
  await page.reload();
  await page.waitForSelector("#bonuses label");
  const seen = [];
  for (let i = 0; i < 3; i++) {
    await page.click("#scan");
    await scanDone();
    seen.push((await bonusCards()).map((c) => c.text.match(/Seller \d/)[0]).sort().join());
  }
  check("each bonus scan reads the next pages, then starts over", seen[0] === "Seller 1,Seller 2" && seen[1] === "Seller 3,Seller 4" && seen[2] === "Seller 1,Seller 2", seen.join(" | "));
  await setFakeFlag("deep", false);
  await setStore("cdm.bonus.filters", {});
  await page.evaluate(() => { localStorage.removeItem("cdm.bonus.cursor"); localStorage.removeItem("cdm.bonus.cache"); });
  await setStore("cdm.filters", filters);

  section("Update notice");
  let fakeBuild = "build-A";
  await page.route("**/api/me", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), build: fakeBuild } });
  });
  await page.goto(BASE + "/app/settings.html");
  await page.waitForTimeout(800);
  check("no update bar when nothing changed", (await page.$("#update-bar")) === null);
  fakeBuild = "build-B";
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  check("update bar appears after a new deploy", await page.waitForSelector("#update-bar", { timeout: 5000 }).then(() => true, () => false));
  await page.unroute("**/api/me");

  section("Leaderboard");
  await page.goto(BASE + "/app/leaderboard.html");
  await page.waitForSelector("#board .empty, #board .item");
  check("leaderboard page loads", await page.isVisible("#range"));

  check("no JavaScript errors anywhere", errors.length === 0, errors.join(" | "));
  await browser.close();
}

try {
  await startEnvironment();
  await runChecks();
} catch (err) {
  fail(err);
}
finish();
