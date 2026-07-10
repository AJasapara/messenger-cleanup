#!/usr/bin/env node
/**
 * Messenger cleanup — drives messenger.com to unsend the messages listed in
 * tasks.json (produced by scan.py). Everything runs in a real browser window
 * you stay logged into; Messenger has no API, so this automates the UI.
 *
 * How it works (selectors verified against the live messenger.com DOM):
 *   - Messages: div[aria-roledescription="message"] with data-message-id and
 *     aria-label "At <time>, You: <text>" (", You: " marks your own messages).
 *   - Unsend chain: hover message → [aria-label="More actions"] →
 *     menuitem "Unsend message" → dialog (radio "Unsend for everyone" is
 *     pre-checked) → button "Remove".
 *   - In-conversation search: open via "Conversation information" (i) →
 *     "Search" row → input. Result rows are unlabeled div[role=button]:
 *     line 1 = sender, line 2 = snippet.
 *   - Thread IDs from the export work for group/inbox threads; 1:1 threads that
 *     migrated to end-to-end encryption open a dead "Facebook user" placeholder,
 *     so we fall back to global search by name and cache the resolved id.
 *
 * If Messenger's UI changes, edit selectors.json — the strings live there.
 *
 * Usage:
 *   node unsend.js                 # run (resumes automatically)
 *   node unsend.js --list          # print thread queue and exit
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
    p.resolvedIds = p.resolvedIds || {};
    return p;
  }
  return { threads: {}, resolvedIds: {}, totalUnsent: 0 };
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

/** Text visible in the conversation header/main region. */
async function mainText(page) {
  return page.evaluate(() => {
    const m = document.querySelector('[role="main"]');
    return m ? (m.innerText || "").slice(0, 400) : "";
  }).catch(() => "");
}

/**
 * Open a thread: try the export thread ID first; if it lands on a dead
 * "Facebook user" placeholder (E2EE-migrated 1:1s), fall back to global
 * search by name. Returns true when the right thread is open.
 */
async function navigateToThread(page, thread, progress) {
  const expectName = thread.title || thread.participants[0] || "";
  const tryIds = [progress.resolvedIds[thread.thread_dir], thread.thread_id].filter(Boolean);

  for (const id of tryIds) {
    await page.goto(`${MESSENGER}/t/${id}`, { waitUntil: "networkidle2", timeout: 60000 });
    await jitter(3000, 4500);
    const text = await mainText(page);
    if (text.includes("Facebook user")) continue; // dead placeholder
    if (normalize(text).includes(normalize(expectName).slice(0, 25))) return true;
    // Header didn't match but not a known-dead marker — check messages render
    if ((await page.$$(SEL.message[0])).length > 0) return true;
  }

  // Fallback: global search by name
  console.log(`    thread id dead → resolving "${expectName}" via global search…`);
  const gs = await find(page, "globalSearchInput", { timeout: 5000 });
  if (!gs) throw new Error("global search input not found");
  await mouseClick(page, gs);
  await jitter(600, 1200);
  await page.keyboard.type(expectName, { delay: 70 + Math.random() * 50 });
  await jitter(2500, 3500);

  // Pick the option whose label matches the name (skip "Search messages for …")
  const options = await page.$$(SEL.globalSearchOption[0]);
  let target = null;
  for (const opt of options) {
    const label = normalize(await opt.evaluate((e) => e.getAttribute("aria-label") || e.innerText || ""));
    if (label.startsWith("search messages")) continue;
    if (label === normalize(expectName) || label.startsWith(normalize(expectName))) { target = opt; break; }
  }
  if (!target) {
    await page.keyboard.press("Escape");
    throw new Error(`no global-search result matching "${expectName}"`);
  }
  await mouseClick(page, target);
  await jitter(3500, 5000);

  const text = await mainText(page);
  if (!normalize(text).includes(normalize(expectName).slice(0, 25))) {
    throw new Error(`landed on wrong thread (header: ${text.slice(0, 60)})`);
  }
  const m = page.url().match(/\/t\/([^/?#]+)/);
  if (m) {
    progress.resolvedIds[thread.thread_dir] = m[1];
    saveProgress(progress);
    console.log(`    resolved → t/${m[1]} (cached)`);
  }
  // Close the global-search dropdown so it can't swallow the next click.
  await page.keyboard.press("Escape").catch(() => {});
  await jitter(600, 1000);
  return true;
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

  const menuItem = await find(page, "unsendMenuItem", { timeout: 4000 });
  if (!menuItem) {
    await page.keyboard.press("Escape");
    throw new Error("'Unsend message' menu item not found");
  }
  await mouseClick(page, menuItem);

  const dialog = await find(page, "dialog", { timeout: 5000 });
  if (!dialog) throw new Error("unsend dialog did not open");
  await jitter(500, 1000);

  // "Unsend for everyone" (value=0) is pre-checked; click it if somehow not.
  const radio = await page.$(SEL.unsendForEveryoneRadio[0]);
  if (radio) {
    const checked = await radio.evaluate((r) => r.checked || r.getAttribute("aria-checked") === "true");
    if (!checked) { await mouseClick(page, radio); await jitter(300, 600); }
  }

  if (!(await clickDialogButton(page, "Remove", { timeout: 5000 }))) {
    await page.keyboard.press("Escape");
    throw new Error("Remove confirm button not found/enabled in dialog");
  }
  await page.waitForSelector(SEL.dialog[0], { hidden: true, timeout: 8000 }).catch(() => {});
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
  let unsent = 0;

  await searchInConversation(page, search_word);

  // Sweep whatever rendered immediately.
  unsent += await sweepRenderedMatches(page, targetSet, threadState, progress, cap);

  // Click through result rows — own rows ("You") first; if none exist at all,
  // fall back to clicking every row (a click merely renders that region).
  const clicked = new Set();
  let stalePasses = 0;

  for (let iter = 0; iter < 80 && stalePasses < 3; iter++) {
    if (unsent >= messages.length) break;
    if (cap && progress.totalUnsent >= cap) break;

    // Panel can close after unsend interactions — reopen if needed.
    if (!(await page.$(SEL.conversationSearchInput[0]))) {
      await searchInConversation(page, search_word).catch(() => {});
    }

    const rows = await collectResultRows(page).catch(() => []);
    const own = rows.filter((r) => isOwnRow(r) && !clicked.has(r.key));
    const anyUnclicked = rows.filter((r) => !clicked.has(r.key));
    const pick = own[0] || (rows.some(isOwnRow) ? null : anyUnclicked[0]);

    if (!pick) {
      // No new relevant rows visible — scroll panel to load more.
      const before = rows.length;
      await scrollResults(page);
      const after = (await collectResultRows(page).catch(() => [])).length;
      if (after <= before) stalePasses++; else stalePasses = 0;
      continue;
    }

    clicked.add(pick.key);
    try { await mouseClick(page, pick.handle); } catch { continue; }
    await jitter(2000, 3200); // wait for the jump

    unsent += await sweepRenderedMatches(page, targetSet, threadState, progress, cap);
  }

  console.log(`      → ${unsent}/${expected_matches} unsent for "${search_word}"`);
  const clear = await find(page, "clearSearchButton", { timeout: 800 });
  if (clear) await mouseClick(page, clear).catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
  return unsent;
}

// ─── Main ──────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const listOnly = args.includes("--list");
  const auto = args.includes("--auto");
  const smallest = args.includes("--smallest");
  const largest = args.includes("--largest");
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

  const loggedIn = await find(page, "composer", { timeout: 5000 });
  if (!loggedIn && !page.url().includes("/t/")) {
    console.log("\n  Log in to messenger.com in the browser window.");
    console.log("  If prompted, enter your E2EE PIN so encrypted chats load.");
    await prompt.ask("  Press ENTER when you can see your chats... ");
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
