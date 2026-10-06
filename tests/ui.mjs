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
  const filters = { minPrice: 15000000, priceTol: 100, maxItems: 5, autoScan: true, maxSellers: 20 };
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
  // Foxtrot: $16m at market, so profit is the mug alone: 16m x 5% = +$800k (good). Merits + 20% plunder: 5% x 1.3 = 6.5% = +$1.04m.
  const foxtrot = async () => page.$$eval("#results .target", (cs) => (cs.find((c) => c.textContent.includes("Foxtrot")) || {}).textContent || "");
  check("expected profit at base rate", /\+\$800k/.test(await foxtrot()), await foxtrot());
  await page.click("summary:has-text('More options')");
  await page.check("#merits");
  await page.fill("#plunder", "20");
  check("merits and plunder raise the expected profit", /\+\$1\.04m/.test(await foxtrot()), await foxtrot());
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

  section("Inactive earners");
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
  await page.goto(BASE + "/app/settings.html");
  const keyLink = await page.getAttribute("#make-key", "href");
  check("the key made from Settings asks for everything the site uses", /company=[^&]*employees/.test(keyLink) && /torn=[^&]*companies/.test(keyLink) && /torn=[^&]*attacklog/.test(keyLink) && /user=[^&]*personalstats/.test(keyLink) && /user=basic,profile,battlestats,attacks/.test(keyLink), keyLink);
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
  check("only inactive players at companies with enough stars", efound.map((c) => c.name).join() === "Rex,Pia", efound.map((c) => c.name).join());
  check("estimated cash: 60% of $1m daily income / 3 employees = $200k a day x days inactive, labelled rough", /~\$6m \(rough\)/.test(efound[0].text) && /~\$2m \(rough\)/.test(efound[1].text), efound.map((c) => c.text.slice(0, 120)).join(" | "));
  check("cards show company, type, stars, position, profile and attack buttons", /Deep Co · Mining Corporation · 10★/.test(efound[0].text) && /Miner/.test(efound[0].text) && efound[0].link === "Profile,Attack", efound[0].link);
  check("cards show stats, fair fight, age and status", /Est\. stats2b/.test(efound[0].text) && /Fair fight1\.50/.test(efound[0].text) && /Account age\d+ days/.test(efound[0].text) && /Status(Okay|Out|Hospital)/.test(efound[0].text), efound[0].text);
  check("mug rating and predicted mug shown", /Mug rating(Excellent|Good|Fair|Poor) \(\d+\/100\)/.test(efound[0].text) && /Predicted mug~\$300k \(rough\)/.test(efound[0].text), efound[0].text.slice(0, 220));
  check("net worth shown and counted in the rating", /Net worth\$2\.3b/.test(efound[0].text), efound[0].text.slice(0, 220));
  check("the best mug is listed first (Rex: more cash, idle longer, richer)", efound[0].name === "Rex", efound.map((c) => c.name).join());
  await page.click("details.more > summary");
  await page.check("#merits");
  await page.fill("#plunder", "20");
  check("merits and Plunder raise the predicted mug", /Predicted mug~\$390k/.test((await earnCards())[0].text), (await earnCards())[0].text.slice(0, 200));
  await page.uncheck("#merits");
  await page.fill("#plunder", "0");
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
  await setStore("cdm.earn.filters", { types: [5], minStars: 5, minDays: 7, sort: "cash", dir: "desc" });
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
  await setStore("cdm.earn.filters", { types: [12], minStars: 5, minDays: 7 });
  await setStore("cdm.earn.wages", { base: 500000, types: {} });

  section("Inactive earners keep searching");
  // 27 companies at 10 stars: the scan goes on batch after batch until it has them all, or has enough.
  await setFakeFlag("manyCompanies", true);
  await page.goto(BASE + "/app/earners.html");
  await page.waitForFunction(() => document.getElementById("maxBs").value !== "");
  await page.evaluate(() => { localStorage.removeItem("cdm.earn.cache"); localStorage.removeItem("cdm.calls"); localStorage.removeItem("cdm.profiles"); });
  await setStore("cdm.earn.filters", { types: [12], minStars: 5, minDays: 7, maxPlayers: 80 });
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
  await setStore("cdm.earn.filters", { types: [12], minStars: 5, minDays: 7, maxPlayers: 5 });
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
  await setStore("cdm.earn.filters", { types: [12], minStars: 5, minDays: 7 });
  await page.reload();
  await page.waitForSelector("#types label");
  await page.click("#scan");
  await page.waitForSelector("#scan:not([disabled])", { timeout: 120000 });
  efound = await earnCards();
  check("without personal stats access it still finds players with status and age, net worth unknown", efound.length === 2 && /Account age100 days/.test(efound[0].text) && /Net worth\?/.test(efound[0].text) && /Net worth could not be read/.test(await text("#scan-msg")), `${efound.length} | ${await text("#scan-msg")}`);
  await setFakeFlag("combinedFail", false);
  await page.evaluate(() => { localStorage.removeItem("cdm.earn.cache"); localStorage.removeItem("cdm.profiles"); });
  await setStore("cdm.earn.filters", { types: [12], minStars: 5, minDays: 7 });

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
  await setStore("cdm.bonus.filters", { maxBs: 5000000000 });
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
  await setStore("cdm.bonus.filters", { maxBs: 5000000000, bonuses: ["Expose"] });
  await page.reload();
  await page.waitForSelector("#bonuses label");
  bw = await scanBonusPage();
  check("a bonus choice finds only that bonus", bw.map((c) => c.name).join() === "Fake Katana" && /rarity-red/.test(bw[0].rarity), bw.map((c) => c.name).join());
  await setStore("cdm.bonus.filters", { maxBs: 5000000000, rarities: ["yellow"], maxPrice: 50000000 });
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
  await setStore("cdm.bonus.filters", { maxBs: 5000000000, rarities: ["yellow"], pages: 2 });
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
