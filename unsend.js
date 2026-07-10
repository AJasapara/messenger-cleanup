#!/usr/bin/env node
/**
 * Messenger cleanup — drives messenger.com to unsend the messages listed in
 * tasks.json (produced by scan.py). Everything runs in a real browser window
 * you stay logged into; Messenger has no API, so this automates the UI.
 *
 * How it works (selectors verified against the live messenger.com DOM):
 *   - Your messages: div[aria-roledescription="message"] whose aria-label reads
 *     "At <time>, You: <text>". The ", You:" marks messages you sent — this holds
 *     even in threads where nicknames are set.
 *   - Unsend chain: hover a message → "More actions" → the "Unsend message" menu
 *     item (or "Remove message" when the other account is deactivated) → confirm
 *     dialog → "Remove".
 *   - In-conversation search: open via "Conversation information" (i) → "Search".
 *   - Finding the right thread: export thread IDs are often stale (threads that
 *     moved to end-to-end encryption get reassigned new IDs), so navigation falls
 *     back to the left "Search Messenger" box — by participant name, then by
 *     message text ("Search messages for …") — and caches the resolved URL.
 *
 * If Messenger's UI changes, edit selectors.json — the strings live there.
 *
 * Usage:
 *   node unsend.js                 # run (resumes automatically)
 *   node unsend.js --list          # print the thread queue and exit
 *   node unsend.js --smallest      # process fewest-message threads first
 *   node unsend.js --largest       # process biggest threads first (default)
 *   node unsend.js --thread <id>   # process a single thread
 *   node unsend.js --cap 250       # stop after N unsends this session
 *   node unsend.js --auto          # no per-thread confirmation (full auto)
 */

const puppeteer = require("puppeteer");
const readline = require("readline");
const fs = require("fs");
const path = require("path");

const TASKS_FILE = path.join(__dirname, "tasks.json");
const PROGRESS_FILE = path.join(__dirname, "progress.json");
const SELECTORS_FILE = path.join(__dirname, "selectors.json");
const PROFILE_DIR = path.join(__dirname, "chrome-profile");
const FAILURE_DIR = path.join(__dirname, "failures");
const MESSENGER = "https://www.messenger.com";

const SEL = JSON.parse(fs.readFileSync(SELECTORS_FILE, "utf-8"));
if (!fs.existsSync(TASKS_FILE)) {
  console.error("No tasks.json found. Run `python3 scan.py` first (see the README).");
  process.exit(1);
}
const TASKS = JSON.parse(fs.readFileSync(TASKS_FILE, "utf-8"));
const ME = TASKS.me || ""; // your own search-result rows show your name, not "You"

// A search-result row is one of my messages if the sender line is "You"
// (group threads) or my own name (observed in 1:1 threads).
const isOwnRow = (r) => r.sender === "You" || r.sender === ME;

// ─── Small utilities ───────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => sleep(min + Math.random() * (max - min));

function pacific(tsMs) {
  return new Date(tsMs).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: true,
  });
}

function makePrompt() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask: (q) => new Promise((res) => rl.question(q, res)),
    close: () => rl.close(),
  };
}

function loadProgress() {
  if (fs.existsSync(PROGRESS_FILE)) {
    const p = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf-8"));
    p.resolvedUrls = p.resolvedUrls || {};
    return p;
  }
  return { threads: {}, resolvedUrls: {}, totalUnsent: 0 };
}
const saveProgress = (p) => fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2));

const normalize = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();

async function find(page, key, { timeout = 2500 } = {}) {
  for (const sel of SEL[key]) {
    try {
      const el = await page.waitForSelector(sel, { visible: true, timeout });
      if (el) return el;
    } catch { /* next candidate */ }
  }
  return null;
}

/** Real-mouse click at an element's center (React ignores some synthetic clicks). */
async function mouseClick(page, el) {
  const box = await el.boundingBox();
  if (!box) throw new Error("element has no bounding box");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

/**
 * Click a dialog button by aria-label, choosing the ENABLED, non-hidden copy.
 * Facebook renders duplicate button nodes during the open animation — one is
 * aria-disabled/aria-hidden with tabindex=-1, the other is the live control.
 * Polls until the live one is clickable. Returns true on success.
 */
async function clickDialogButton(page, label, { timeout = 5000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const rect = await page.evaluate((lbl) => {
      const dialogs = [...document.querySelectorAll('div[role="dialog"]')];
      const dialog = dialogs[dialogs.length - 1] || document;
      const btns = [...dialog.querySelectorAll(`[role="button"][aria-label="${lbl}"]`)];
      const live = btns.find((b) =>
        b.getAttribute("aria-disabled") !== "true" &&
        b.getAttribute("aria-hidden") !== "true" &&
        b.getAttribute("tabindex") !== "-1" &&
        b.getBoundingClientRect().width > 0
      );
      if (!live) return null;
      const r = live.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, label);
    if (rect) { await page.mouse.click(rect.x, rect.y); return true; }
    await sleep(250);
  }
  return false;
}

async function screenshotFailure(page, label) {
  fs.mkdirSync(FAILURE_DIR, { recursive: true });
  const file = path.join(FAILURE_DIR, `${Date.now()}_${label.replace(/[^a-z0-9]+/gi, "_").slice(0, 60)}.png`);
  try {
    await page.screenshot({ path: file });
    console.log(`      📸 saved ${path.relative(__dirname, file)}`);
  } catch { /* page may be gone */ }
}

// ─── Navigation ────────────────────────────────────────────────

/** How many messages are currently rendered — the reliable "loaded" signal.
 *  (The header can read "Facebook user" and a spinner can linger even on a
 *  fully-loaded E2EE thread, so those are NOT reliable; message count is.) */
async function renderedMessageCount(page) {
  return page.evaluate(() => document.querySelectorAll('[aria-roledescription="message"]').length).catch(() => 0);
}

async function waitForMessages(page, ms = 12000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if ((await renderedMessageCount(page)) > 0) return true;
    await sleep(1000);
  }
  return false;
}

/** Focus the left "Search Messenger" box, clear it, type a query, let it settle. */
async function typeGlobalSearch(page, query) {
  const gs = await find(page, "globalSearchInput", { timeout: 6000 });
  if (!gs) throw new Error("global search input not found");
  await mouseClick(page, gs);
  await jitter(500, 900);
  await page.keyboard.down("Meta"); await page.keyboard.press("a"); await page.keyboard.up("Meta");
  await page.keyboard.press("Backspace");
  await page.keyboard.type(query, { delay: 55 + Math.random() * 45 });
  await jitter(2500, 3500);
}

/** Click the global-search result option whose label matches a person/thread
 *  name (skips the "Search messages for …" action row). Returns true if clicked. */
async function clickNameOption(page, name) {
  const handle = await page.evaluateHandle((nm) => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
    const want = norm(nm);
    const opts = [...document.querySelectorAll('[role="option"]')].filter((e) => e.offsetParent !== null);
    return opts.find((e) => {
      const l = norm(e.getAttribute("aria-label") || e.innerText || "");
      return !l.startsWith("search ") && (l === want || l.startsWith(want) || l.includes(want));
    }) || null;
  }, name);
  const el = handle.asElement();
  if (!el) return false;
  await mouseClick(page, el);
  return true;
}

/** After a thread opens, confirm one of MY messages with this exact text is
 *  actually here (via in-conversation search). This is the guard that lets
 *  text-search reject a wrong-thread match instead of unsending in it. */
async function verifyOwnMessage(page, sampleText) {
  const word = (sampleText.split(/\s+/).sort((a, b) => b.length - a.length)[0] || sampleText)
    .toLowerCase().replace(/[^a-z0-9]/gi, "").slice(0, 20);
  if (!word) return false;
  try {
    await searchInConversation(page, word);
    const rows = await collectResultRows(page);
    // Match on the snippet text, not the sender — in nickname threads the
    // sender column shows a nickname, but a matching snippet is proof enough
    // (the search term came from one of my own sent messages).
    const want = normalize(sampleText).slice(0, 15);
    const ok = rows.some((r) => normalize(r.snippet).includes(want));
    const clear = await find(page, "clearSearchButton", { timeout: 700 });
    if (clear) await mouseClick(page, clear).catch(() => {});
    await page.keyboard.press("Escape").catch(() => {});
    return ok;
  } catch { return false; }
}

/**
 * Resolve a thread by searching a distinctive message text: type the text,
 * click the top "Search messages for …" option, click the result row that
 * matches the participant name or the snippet (never a blind first row — that
 * risks a wrong thread), then VERIFY the target message is really present.
 * Returns true only when the correct thread is open.
 */
async function resolveByMessageText(page, text, expectName) {
  await typeGlobalSearch(page, text);

  const sm = await page.evaluateHandle(() => {
    const opts = [...document.querySelectorAll('[role="option"]')].filter((e) => e.offsetParent !== null);
    return opts.find((e) => /^search messages/i.test((e.getAttribute("aria-label") || e.innerText || "").trim())) || null;
  });
  if (!sm.asElement()) { await page.keyboard.press("Escape").catch(() => {}); return false; }
  await mouseClick(page, sm.asElement());
  await jitter(2500, 3500);

  const pick = await page.evaluateHandle((expect, snippet) => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
    const href = (e) => e.getAttribute("href") ||
      (e.querySelector && e.querySelector('a[href*="/t/"]') && e.querySelector('a[href*="/t/"]').getAttribute("href")) || "";
    // Real result rows: non-empty text AND a clean /t/<id> or /e2ee/t/<id> href
    // (excludes the persistent nav shortcuts, which have ?focus_target params).
    const rows = [...document.querySelectorAll('[role="option"], a[href*="/t/"], [role="listitem"]')]
      .filter((e) => e.offsetParent !== null && (e.innerText || "").trim().length > 0);
    const isThread = (e) => /^\/(e2ee\/)?t\/\d+\/?$/.test(href(e));
    const threads = rows.filter(isThread);
    const named = expect && threads.find((e) => norm(e.innerText).includes(norm(expect)));
    const snip = threads.find((e) => norm(e.innerText).includes(norm(snippet).slice(0, 18)));
    return named || snip || null; // no blind fallback
  }, expectName, text);
  if (!pick.asElement()) { await page.keyboard.press("Escape").catch(() => {}); return false; }
  await mouseClick(page, pick.asElement());

  if (!(await waitForMessages(page, 12000))) { await page.keyboard.press("Escape").catch(() => {}); return false; }
  await page.keyboard.press("Escape").catch(() => {});
  return await verifyOwnMessage(page, text);
}

/**
 * Open the correct current thread. Export thread IDs are often stale (threads
 * migrated to E2EE get new IDs + an /e2ee/ URL prefix), so:
 *   1. Try any cached URL, then the export /t/<id> (fast path for still-valid ids).
 *   2. Global search by participant/thread name (handles E2EE + nickname threads;
 *      we trust the name-matched option and verify by messages rendering, never
 *      by the header — nicknames make the header differ).
 *   3. Global search by message text → "Search messages for …" → matching result
 *      (handles deactivated accounts, unsearchable names, and group threads).
 * Caches the resolved URL so re-runs are fast.
 */
async function navigateToThread(page, thread, progress) {
  const expectName = thread.title || thread.participants[0] || "";
  progress.resolvedUrls = progress.resolvedUrls || {};

  const cache = (how) => {
    const p = page.url().replace(MESSENGER, "");
    if (/^\/(e2ee\/)?t\//.test(p)) { progress.resolvedUrls[thread.thread_dir] = p; saveProgress(progress); }
    console.log(`    opened via ${how} → ${p}`);
  };

  // 1. Fast paths.
  const direct = [];
  if (progress.resolvedUrls[thread.thread_dir]) direct.push(progress.resolvedUrls[thread.thread_dir]);
  if (thread.thread_id) direct.push(`/t/${thread.thread_id}`);
  for (const p of direct) {
    await page.goto(MESSENGER + p, { waitUntil: "networkidle2", timeout: 60000 });
    if (await waitForMessages(page, 8000)) { cache("direct id"); return true; }
  }

  // 2. Global search by name.
  if (expectName && !/facebook user/i.test(expectName)) {
    console.log(`    resolving "${expectName}" via name search…`);
    await typeGlobalSearch(page, expectName);
    if (await clickNameOption(page, expectName)) {
      if (await waitForMessages(page, 12000)) { await page.keyboard.press("Escape").catch(() => {}); cache("name search"); return true; }
    }
    await page.keyboard.press("Escape").catch(() => {});
  }

  // 3. Global search by message text — try the most distinctive (longest,
  //    unique) messages first, since common phrases surface the wrong thread.
  const samples = [...new Set(thread.groups.flatMap((g) => g.messages.map((m) => m.text)))]
    .filter((t) => t && t.trim().length >= 8)
    .sort((a, b) => b.length - a.length)
    .slice(0, 4);
  for (const sample of samples) {
    console.log(`    resolving via message text: "${sample.slice(0, 40)}"…`);
    if (await resolveByMessageText(page, sample, expectName)) { cache("text search"); return true; }
  }

  throw new Error(`could not open "${expectName}" via id, name, or message-text search`);
}

// ─── In-conversation search ────────────────────────────────────

/** Open the search input via Conversation information → Search.
 *  Retries the (i) click once — an open overlay can swallow the first click. */
async function openConversationSearch(page) {
  let input = await find(page, "conversationSearchInput", { timeout: 800 });
  if (input) return input;

  let row = null;
  for (let attempt = 0; attempt < 2 && !row; attempt++) {
    const info = await find(page, "conversationInfoButton", { timeout: 3000 });
    if (!info) throw new Error("'Conversation information' button not found");
    await mouseClick(page, info);
    await jitter(1500, 2500);
    row = await find(page, "conversationSearchRow", { timeout: 4000 });
  }
  if (!row) throw new Error("'Search' row not found in info panel");
  await mouseClick(page, row);
  await jitter(800, 1400);

  input = await find(page, "conversationSearchInput", { timeout: 3000 });
  if (!input) throw new Error("search input did not appear");
  return input;
}

async function searchInConversation(page, word) {
  const input = await openConversationSearch(page);
  await input.click({ clickCount: 3 });
  await input.type(word, { delay: 60 + Math.random() * 60 });
  await page.keyboard.press("Enter");
  await jitter(2000, 3000);
}

/**
 * Collect result rows from the search panel with parsed sender/snippet.
 * Returns [{handle, sender, snippet, key}].
 */
async function collectResultRows(page) {
  const rowsHandle = await page.evaluateHandle(() => {
    const inp = document.querySelector('input[placeholder="Search in conversation"]');
    if (!inp) return [];
    let panel = inp;
    for (let i = 0; i < 12 && panel.parentElement; i++) panel = panel.parentElement;
    return [...panel.querySelectorAll('div[role="button"]:not([aria-label])')]
      .filter((b) => (b.innerText || "").trim().length > 0 && (b.innerText || "").length < 400);
  });
  const props = await rowsHandle.getProperties();
  const rows = [];
  for (const v of props.values()) {
    const el = v.asElement();
    if (!el) continue;
    const text = await el.evaluate((e) => e.innerText || "").catch(() => "");
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    rows.push({
      handle: el,
      sender: lines[0] || "",
      snippet: lines[1] || "",
      key: `${lines[0]}|${lines[1]}|${lines[2] || ""}`,
    });
  }
  return rows;
}

/** Scroll the results panel to load more rows. Returns new row count. */
async function scrollResults(page) {
  await page.evaluate(() => {
    const inp = document.querySelector('input[placeholder="Search in conversation"]');
    if (!inp) return;
    let panel = inp;
    for (let i = 0; i < 12 && panel.parentElement; i++) panel = panel.parentElement;
    const rows = [...panel.querySelectorAll('div[role="button"]:not([aria-label])')];
    if (rows.length) rows[rows.length - 1].scrollIntoView({ block: "end" });
  });
  await jitter(1500, 2500);
}

// ─── Unsend ────────────────────────────────────────────────────

/** Hover → More actions → Unsend message → dialog → Remove. */
async function unsendMessage(page, msgEl) {
  await msgEl.evaluate((e) => e.scrollIntoView({ block: "center" }));
  await jitter(400, 800);
  await msgEl.hover();
  await jitter(600, 1100);

  // The hover toolbar renders next to the message inside the same row.
  let moreEl = null;
  for (let attempt = 0; attempt < 3 && !moreEl; attempt++) {
    const h = await msgEl.evaluateHandle((e, sel) => {
      const row = e.closest('[role="row"]') || e.parentElement?.parentElement || e;
      const btn = row.querySelector(sel);
      return btn && btn.offsetParent !== null ? btn : null;
    }, SEL.moreActionsButton[0]);
    moreEl = h.asElement();
    if (!moreEl) { await msgEl.hover(); await jitter(500, 900); }
  }
  if (!moreEl) throw new Error("'More actions' button did not appear on hover");
  await mouseClick(page, moreEl);

  // The menu item is "Unsend message" normally; when the other account is
  // deactivated (can't unsend for everyone) Messenger swaps it for a "Remove"
  // item whose aria-label is "Remove message" (innerText "Remove"). Match the
  // verb in either the aria-label OR the text — "Forward"/"Report" won't match.
  const findMenuItem = () => page.evaluateHandle(() => {
    const items = [...document.querySelectorAll('[role="menuitem"]')].filter((e) => e.offsetParent !== null);
    const txt = (e) => ((e.getAttribute("aria-label") || "") + " " + (e.innerText || "")).toLowerCase();
    return items.find((e) => /\bunsend\b/.test(txt(e))) ||
           items.find((e) => /\bremove\b/.test(txt(e))) || null;
  });
  let menuItem = (await findMenuItem()).asElement();
  for (let i = 0; i < 6 && !menuItem; i++) { await sleep(400); menuItem = (await findMenuItem()).asElement(); }
  if (!menuItem) {
    await page.keyboard.press("Escape");
    throw new Error("neither 'Unsend message' nor 'Remove' menu item found");
  }
  await mouseClick(page, menuItem);

  // A confirm dialog usually appears (normal unsend, and often the deactivated
  // "Remove" too). If it does: select "Unsend for everyone" when offered, then
  // click the "Remove" confirm. If no dialog appears, the removal already
  // happened (some deactivated cases) — that's success.
  const dialog = await find(page, "dialog", { timeout: 3500 });
  if (dialog) {
    await jitter(500, 1000);
    const radio = await page.$(SEL.unsendForEveryoneRadio[0]);
    if (radio) {
      const checked = await radio.evaluate((r) => r.checked || r.getAttribute("aria-checked") === "true");
      if (!checked) { await mouseClick(page, radio); await jitter(300, 600); }
    }
    if (!(await clickDialogButton(page, "Remove", { timeout: 5000 }))) {
      await page.keyboard.press("Escape");
      throw new Error("confirm 'Remove' button not found/enabled in dialog");
    }
    await page.waitForSelector(SEL.dialog[0], { hidden: true, timeout: 8000 }).catch(() => {});
  }
  await jitter(800, 1500);
}

/**
 * Sweep rendered messages: unsend every own message whose exact text matches
 * a target. Returns count unsent.
 */
async function sweepRenderedMatches(page, targetSet, threadState, progress, cap) {
  let unsent = 0;

  for (let pass = 0; pass < 25; pass++) {
    const messages = await page.$$(SEL.message[0]);
    let candidate = null, candidateId = null, preview = "";

    for (const el of messages) {
      const info = await el.evaluate((e) => ({
        label: e.getAttribute("aria-label") || "",
        id: e.getAttribute("data-message-id") || "",
      })).catch(() => null);
      if (!info) continue;
      const m = info.label.match(/,\s*You:\s*([\s\S]+)$/);
      if (!m) continue;
      if (threadState.doneIds.includes(info.id)) continue;
      if (!targetSet.has(normalize(m[1]))) continue;
      candidate = el; candidateId = info.id; preview = m[1].slice(0, 50);
      break;
    }
    if (!candidate) break;

    await unsendMessage(page, candidate);

    threadState.doneIds.push(candidateId);
    threadState.unsentCount++;
    progress.totalUnsent++;
    saveProgress(progress);
    unsent++;
    console.log(`      ✓ unsent "${preview}"  (${progress.totalUnsent} total)`);

    if (cap && progress.totalUnsent >= cap) break;
    await jitter(1800, 3800);
  }
  return unsent;
}

/** Process one search-word group in the currently open thread. */
async function processGroup(page, group, threadState, progress, cap) {
  const { search_word, expected_matches, messages } = group;
  console.log(`\n    ── "${search_word}" (${expected_matches} expected) ──`);
  for (const m of messages.slice(0, 3)) {
    console.log(`       ${pacific(m.timestamp_ms)}  "${m.text.slice(0, 70)}"`);
  }
  if (messages.length > 3) console.log(`       … and ${messages.length - 3} more`);

  const targetSet = new Set(messages.map((m) => normalize(m.text)));

  // Run one search query: sweep what renders, then click through result rows
  // to page the thread and sweep each region. Returns messages unsent.
  const runSearch = async (query) => {
    let got = 0;
    await searchInConversation(page, query);
    got += await sweepRenderedMatches(page, targetSet, threadState, progress, cap);

    const clicked = new Set();
    let stalePasses = 0;
    for (let iter = 0; iter < 80 && stalePasses < 3; iter++) {
      if (got >= messages.length) break;
      if (cap && progress.totalUnsent >= cap) break;
      if (!(await page.$(SEL.conversationSearchInput[0]))) {
        await searchInConversation(page, query).catch(() => {});
      }
      const rows = await collectResultRows(page).catch(() => []);
      const own = rows.filter((r) => isOwnRow(r) && !clicked.has(r.key));
      const anyUnclicked = rows.filter((r) => !clicked.has(r.key));
      // Prefer my own rows, but fall back to any row: clicking it scrolls the
      // thread and the sweep (keyed on the "You:" aria-label) still finds mine,
      // which also makes nickname threads work.
      const pick = own[0] || anyUnclicked[0];
      if (!pick) {
        const before = rows.length;
        await scrollResults(page);
        const after = (await collectResultRows(page).catch(() => [])).length;
        if (after <= before) stalePasses++; else stalePasses = 0;
        continue;
      }
      clicked.add(pick.key);
      try { await mouseClick(page, pick.handle); } catch { continue; }
      await jitter(2000, 3200);
      got += await sweepRenderedMatches(page, targetSet, threadState, progress, cap);
    }
    const clear = await find(page, "clearSearchButton", { timeout: 800 });
    if (clear) await mouseClick(page, clear).catch(() => {});
    await page.keyboard.press("Escape").catch(() => {});
    return got;
  };

  let unsent = await runSearch(search_word);

  // Fallback ONLY for glued words: when the search word is fused inside a longer
  // token (a word run together with no spaces), Messenger's word-based search
  // won't surface it — retry with the whole containing token, which prefix-
  // matches it. If the word stands alone in the message, the primary search
  // already covered it (a miss means the message is already gone), so retrying
  // with other words — especially common ones — is pointless; skip it.
  if (unsent < messages.length) {
    const sw = search_word.toLowerCase();
    const swEsc = sw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const standalone = new RegExp(`(^|\\s)${swEsc}(\\s|$)`, "i"); // whitespace-bounded
    const gluedTokens = new Set();
    for (const m of messages) {
      if (standalone.test(m.text)) continue;
      const token = (m.text.split(/\s+/).find((t) => t.toLowerCase().includes(sw)) || "").toLowerCase();
      // A real fused word is short; a 40+ char "token" is base64/a URL — never search it.
      if (token.length >= 4 && token.length <= 40 && token !== sw && !/^data:|^https?:/.test(token)) {
        gluedTokens.add(token);
      }
    }
    for (const q of gluedTokens) {
      if (unsent >= messages.length || (cap && progress.totalUnsent >= cap)) break;
      console.log(`      ↻ glued word — retrying with token "${q}"…`);
      unsent += await runSearch(q);
    }
  }

  console.log(`      → ${unsent}/${expected_matches} unsent for "${search_word}"`);
  return unsent;
}

// ─── Main ──────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const listOnly = args.includes("--list");
  const auto = args.includes("--auto");
  const smallest = args.includes("--smallest");
  const largest = args.includes("--largest");
  const navcheck = args.includes("--navcheck"); // read-only: open each thread, report, never unsend
  const onlyThread = args.includes("--thread") ? args[args.indexOf("--thread") + 1] : null;
  const cap = args.includes("--cap") ? parseInt(args[args.indexOf("--cap") + 1], 10) : null;

  const tasks = TASKS;
  const progress = loadProgress();

  let queue = tasks.threads.filter((t) => {
    const st = progress.threads[t.thread_dir];
    return !st || (st.status !== "done" && st.status !== "skipped");
  });
  if (onlyThread) queue = tasks.threads.filter((t) => t.thread_id === onlyThread);

  // Ordering: default is tasks.json order (largest-first). --smallest does
  // breadth-before-depth (fewest messages first); --largest forces the default.
  if (smallest) queue = [...queue].sort((a, b) => a.message_count - b.message_count);
  else if (largest) queue = [...queue].sort((a, b) => b.message_count - a.message_count);

  console.log("╔════════════════════════════════════════════════════════╗");
  console.log("║           Messenger Unsend Tool v2                     ║");
  console.log("╚════════════════════════════════════════════════════════╝");
  console.log(`  Threads remaining: ${queue.length}/${tasks.total_threads}`);
  console.log(`  Messages unsent so far: ${progress.totalUnsent}/${tasks.total_messages}`);
  if (cap) console.log(`  Session cap: ${cap} unsends`);

  if (listOnly) {
    for (const t of queue) {
      const who = t.title || t.participants.slice(0, 3).join(", ");
      console.log(`  ${String(t.message_count).padStart(4)}  ${who}  [${t.source}]  t/${t.thread_id}`);
    }
    return;
  }

  const prompt = makePrompt();
  const browser = await puppeteer.launch({
    headless: false,
    userDataDir: PROFILE_DIR,
    defaultViewport: null,
    protocolTimeout: 180000,
    args: ["--start-maximized", "--disable-blink-features=AutomationControlled"],
  });
  const page = (await browser.pages())[0];
  await page.goto(MESSENGER, { waitUntil: "networkidle2", timeout: 60000 });

  const loggedIn = await find(page, "globalSearchInput", { timeout: 8000 });
  if (!loggedIn && !navcheck) {
    console.log("\n  Log in to messenger.com in the browser window.");
    console.log("  If prompted, enter your E2EE PIN so encrypted chats load.");
    await prompt.ask("  Press ENTER when you can see your chats... ");
  }

  // Read-only navigation check: prove each thread opens (and its target words
  // are searchable) without unsending anything.
  if (navcheck) {
    let ok = 0, fail = 0;
    for (const thread of queue) {
      const who = thread.title || thread.participants.slice(0, 3).join(", ");
      process.stdout.write(`\n  ${who} [${thread.source}] … `);
      try {
        await navigateToThread(page, thread, progress);
        const n = await renderedMessageCount(page);
        // Confirm an actual target message is findable in-conversation
        // (snippet-based, nickname-proof).
        let found = "?";
        try {
          found = (await verifyOwnMessage(page, thread.groups[0].messages[0].text)) ? "yes" : "not-found";
        } catch { found = "search-failed"; }
        console.log(`OPENED (${n} msgs, target findable: ${found})`);
        ok++;
      } catch (e) {
        console.log(`FAILED — ${e.message}`);
        fail++;
      }
      await jitter(1500, 3000);
    }
    console.log(`\n  navcheck: ${ok} opened, ${fail} failed`);
    await browser.close();
    prompt.close();
    return;
  }

  let sessionUnsent = 0;

  for (const thread of queue) {
    if (cap && progress.totalUnsent >= cap) {
      console.log(`\n  Session cap of ${cap} reached — run again later to continue.`);
      break;
    }
    const who = thread.title || thread.participants.slice(0, 3).join(", ");
    const words = thread.groups.map((g) => `${g.search_word}×${g.expected_matches}`).join(", ");

    console.log("\n" + "═".repeat(60));
    console.log(`  ${who}   [${thread.source}]   ${thread.message_count} message(s)`);
    console.log(`  Words: ${words}`);
    console.log("═".repeat(60));

    if (!auto) {
      const a = await prompt.ask("  [ENTER]=unsend all in thread / [s]kip / [q]uit: ");
      if (a.toLowerCase() === "q") break;
      if (a.toLowerCase() === "s") {
        progress.threads[thread.thread_dir] = { status: "skipped", unsentCount: 0, doneIds: [] };
        saveProgress(progress);
        continue;
      }
    }

    const threadState = progress.threads[thread.thread_dir] ||
      { status: "in_progress", unsentCount: 0, doneIds: [] };
    threadState.doneIds = threadState.doneIds || [];
    threadState.status = "in_progress";
    progress.threads[thread.thread_dir] = threadState;

    try {
      await navigateToThread(page, thread, progress);

      let threadUnsent = 0;
      for (const group of thread.groups) {
        threadUnsent += await processGroup(page, group, threadState, progress, cap);
        if (cap && progress.totalUnsent >= cap) break;
      }
      sessionUnsent += threadUnsent;

      const capped = cap && progress.totalUnsent >= cap;
      const done = threadState.unsentCount >= thread.message_count;
      threadState.status = done ? "done" : (capped ? "partial" : "partial");
      saveProgress(progress);
      console.log(`\n  Thread result: ${threadState.unsentCount}/${thread.message_count} unsent → ${done ? "DONE" : "PARTIAL"}`);
    } catch (err) {
      console.log(`  ✗ ${err.message}`);
      await screenshotFailure(page, who);
      threadState.status = "error";
      threadState.lastError = err.message;
      saveProgress(progress);
      if (!auto) {
        const a = await prompt.ask("  [ENTER]=next thread / [q]uit: ");
        if (a.toLowerCase() === "q") break;
      }
    }

    await jitter(3000, 6000);
  }

  console.log("\n" + "═".repeat(60));
  console.log(`  Session: ${sessionUnsent} unsent | Campaign: ${progress.totalUnsent}/${tasks.total_messages}`);
  const remaining = tasks.threads.filter((t) => {
    const st = progress.threads[t.thread_dir];
    return !st || (st.status !== "done" && st.status !== "skipped");
  }).length;
  console.log(`  Threads remaining: ${remaining}`);
  console.log("═".repeat(60));

  prompt.close();
  await browser.close();
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
