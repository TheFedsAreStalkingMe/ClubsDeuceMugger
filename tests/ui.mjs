// Browser test: the real pages in a real browser, against the fake services.
// Needs Playwright (not part of the project). Point at it if it is not installed normally:
//
//   PLAYWRIGHT=/path/to/playwright/index.mjs CHROMIUM=/path/to/chromium WRANGLER=... node tests/ui.mjs

import { BASE, OWNER, check, fail, finish, section, setFakeStatus, startEnvironment } from "./lib/harness.mjs";

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
    stats: [...e.querySelectorAll("dt")].map((d, i) => [d.textContent, e.querySelectorAll("dd")[i].textContent]).find(([k]) => k === "Stats")?.[1],
  })));
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

  section("Scan");
  const filters = { minPrice: 1000000, priceTol: 100, maxItems: 5, autoScan: true, maxSellers: 20 };
  await page.evaluate(() => localStorage.clear());
  await setStore("cdm.keys", { torn: "abcdefgh12345678", ff: "", ts: "TS_goodkey12345" });
  await setStore("cdm.filters", filters);
  await setStore("cdm.prefs", { notify: true, minJackpot: 10000000, myBs: 50e9, outMinutes: 5, offlineMinutes: 35 });
  await page.reload();
  await page.click("#scan");
  await scanDone();
  check("scan finishes", (await text("#scan-msg")).startsWith("Done."), await text("#scan-msg"));
  check("progress bar fills completely", (await page.$eval("#bar", (b) => b.style.width)) === "100%");
  const found = await cards("#results");
  check("all three sellers listed", found.length === 3, JSON.stringify(found));
  check("seller without a spy is marked Est.", found.some((c) => c.name === "Alpha" && /Est\./.test(c.stats)), JSON.stringify(found));
  check("seller with a spy is marked Spy", found.some((c) => c.name === "Bravo" && /10b Spy/.test(c.stats)), JSON.stringify(found));
  check("each card shows trade activity", (await page.$$eval("#results .target dt", (d) => d.some((x) => x.textContent === "Activity"))));
  check("jackpot alert at the top", await page.waitForSelector("#alerts .alert", { timeout: 3000 }).then(() => true, () => false));

  section("Filters explain empty results");
  await setStore("cdm.filters", { ...filters, maxBs: 100 });
  await page.reload();
  await page.click("#scan");
  await scanDone();
  check("empty result says why", /listings are over your max stats/.test(await text("#scan-msg")), await text("#scan-msg"));

  section("Trade activity");
  // Gold Bar changed a minute ago (busy), Silver Bar has been quiet for two days. Busiest first:
  await setStore("cdm.filters", { ...filters, sort: "activity", dir: "desc" });
  await page.reload();
  await page.click("#scan");
  await scanDone();
  const byActivity = (await cards("#results")).map((c) => c.name);
  check("sort by trade activity puts the busy item first", byActivity.slice(0, 2).sort().join() === "Alpha,Bravo" && byActivity[2] === "Charlie", byActivity.join());
  await setStore("cdm.filters", { ...filters, minActivity: 1 });
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
  await page.click("#make-invite");
  await page.waitForSelector("#invite-box:not([hidden])");
  check("invite link made, with Copy and Share", (await text("#invite-link")).includes("?invite=") && (await page.isVisible("#invite-copy")));
  await page.click("#invite-list .x-btn");
  await page.waitForFunction(() => document.getElementById("invite-box").hidden || document.getElementById("invite-list").children.length === 0);
  check("X closes the invite", true);
  await page.click("#test-ff");
  await page.waitForFunction(() => document.getElementById("keys-msg").textContent.length > 12);
  check("FF Scouter key test answers", /FF Scouter/.test(await text("#keys-msg")), await text("#keys-msg"));

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
