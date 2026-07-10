# Clean Up Messenger Cringe

It's ok. We get it. No judgment here — we were all kids once.

Somewhere in your Facebook Messenger history there are things you'd rather not
have said. Old edgelord phases, dead memes, secondhand-embarrassment one-liners,
whatever. This tool finds the messages **you** sent that match words *you* choose,
and unsends them for you — one clean sweep.

Messenger has no API, so it drives the real website in a browser window you log
into once, and does the clicking for you.

---

## The easy way: let an AI drive it (recommended)

You don't need to be technical. This whole thing was *built* by working with an AI
coding assistant, and the easiest way to use it is the same way — let the AI do the
scanning, the reviewing, and the running for you.

**What you need:** a computer with an AI coding assistant that can run terminal
commands (e.g. [Claude Code](https://claude.com/claude-code), Cursor, or similar),
plus Python 3 and Node.js installed (the AI can help you install those too).

### Step 1 — Download your Facebook data
Go to [facebook.com/dyi](https://www.facebook.com/dyi) →
**Download your information** → **Create export** with:
- **Format: JSON** (important — not HTML)
- **Date range:** All time
- (optional) under *customize*, select just **Messages** to keep it small

Wait for the email, download the zip(s), and unzip them. You'll get a folder called
`your_facebook_activity`. ([Facebook's official instructions](https://www.facebook.com/help/212802592074644).)

### Step 2 — Have the AI scan your messages and build the queue
Open this project folder in your AI assistant and tell it what you want. For example:

> *"I want to clean up offensive/cringe messages I sent on Facebook Messenger. My
> unzipped export is at `<path>` and my name in Messenger is `<Your Name>`. Scan my
> messages, build the list of ones to remove, and show me a summary so I can review
> the scope before anything is deleted."*

The AI will set up your config, run the scan, and produce **`tasks.json`** — the
list of exactly which messages will be removed, per conversation. **Review it with
the AI**: ask it to widen the net ("also catch X"), narrow it ("ignore inside jokes
with my close friends"), or show you specific matches. Nothing is deleted in this step.

### Step 3 — Have the AI run the cleanup
Tell the AI to start it (e.g. *"looks good, run the cleanup"*). It will run the
commands and a Chromium browser window will open.

**Log into messenger.com in that window** (enter your password / 2FA / E2EE PIN if
asked). Your login is remembered after the first time. Then the tool works through
the queue on its own — searching each conversation, finding your messages, and
unsending them. Ask the AI to check progress or read you the status anytime.

That's it. You can run it in one sitting or leave it going in the background.

---

## The manual way (if you're comfortable in a terminal)

```bash
cp config.example.json config.json     # set your_name + export path
cp words.example.txt   words.txt        # put the words you want gone, one per line
python3 scan.py                         # → writes tasks.json (review it)
npm install                             # first time only
node unsend.js --auto                   # log in when the browser opens, then let it run
```

Useful flags:
```bash
node unsend.js --list        # preview the queue without opening a browser
node unsend.js --smallest    # do small threads first
node unsend.js --auto        # run unattended, no per-thread prompt (default recommendation)
node unsend.js               # ask before each conversation (Enter=go, s=skip, q=quit)
node unsend.js --cap 100     # optional: stop after 100 unsends (see note below)
```

It's **resumable** — stop anytime and run it again; progress is saved after every
single unsend, so it picks up right where it left off.

`words.txt` format: one entry per line. Plain lines match a whole word; start a line
with `re:` for a regex fragment; `#` lines are comments.

---

## Good to know

- **You can just let it run.** It paces itself with randomized human-like delays.
  Running it unattended through a large history in one go (even overnight) works
  fine. If you'd rather limit a session, `--cap N` is there, but it isn't required.
- **Unsending is permanent.** Review `tasks.json` first (the AI will show you). Only
  messages **you** sent are ever touched — never anyone else's.
- **Nothing is uploaded anywhere.** Your export, your word list, and your login stay
  on your computer. `.gitignore` keeps all of it out of git.
- **Handled automatically:** stale thread IDs (chats that moved to end-to-end
  encryption get new IDs — it re-finds them by name/message text), threads that use
  nicknames for you, and deactivated accounts (uses "Remove" instead of "Unsend").
- **Encrypted/secret chats** may not be in the standard export. If you have a
  separate per-thread Messenger download (a zip of JSON files), point `e2ee_zip` at
  it in `config.json` and it'll be included too.
- **If a step fails or a button isn't found,** Messenger probably changed its layout.
  The UI strings live in `selectors.json`, and failures drop a screenshot in
  `failures/`. Ask your AI to look at the screenshot and update the selector — that's
  exactly how this tool was maintained. PRs welcome.

MIT licensed. Be kind to your past self. 💛
