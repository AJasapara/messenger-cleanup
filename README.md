# Clean Up Messenger Cringe

It's ok. We get it. No judgment here — we were all kids once.

Somewhere in your Facebook Messenger history there are things you'd rather not
have said. Old edgelord phases, dead memes, secondhand-embarrassment one-liners,
whatever. This tool finds the messages **you** sent that match a word list you
control, and unsends them for you — one clean sweep, at a safe pace, with you in
the driver's seat the whole time.

Messenger has no API, so this drives the real website in a browser window you
log into. You approve each conversation; it does the clicking.

---

## What you need

- **Python 3** and **Node.js** installed.
- **Your Facebook data export** (instructions below). Everything runs against
  *your own* downloaded data — the tool never scrapes anyone else.

---

## Step 1 — Download your Facebook data

1. Go to **facebook.com → Settings & privacy → Settings → Your information and
   permissions → Download your information** (or visit
   [facebook.com/dyi](https://www.facebook.com/dyi)).
2. Click **Create export**, and set:
   - **Format: JSON** (this matters — the tool reads JSON, not HTML)
   - **Media quality:** Low is fine (you're only after text)
   - **Date range:** All time
   - Under **customize**, you can select just **Messages** to make it smaller
     and faster.
3. Wait for the email, download the zip(s), and **unzip** them.
4. You'll get a folder called `your_facebook_activity`. Move it somewhere handy —
   e.g. into an `export/` folder next to this tool, so the path is
   `./export/your_facebook_activity`.

> Big exports arrive as several zips. Unzip them all into the same place; they
> merge into one `your_facebook_activity` folder.

---

## Step 2 — Tell it who you are and what to clean

```bash
cp config.example.json config.json
cp words.example.txt   words.txt
```

Edit **`config.json`**:

```json
{
  "your_name":  "Jane Doe",                        // EXACTLY as it shows in Messenger
  "export_dir": "./export/your_facebook_activity", // where you put the unzipped export
  "e2ee_zip":   "",                                // optional, see note below
  "words_file": "./words.txt"
}
```

Edit **`words.txt`** — put whatever you want gone, one entry per line:

```
cringe
yikes
re:lo+l          # regex: matches lol, loool, looool
```

- Plain lines match that **whole word**, case-insensitively.
- Start a line with `re:` to use a regex fragment for fancier matches.
- `#` lines and blank lines are ignored.

Only messages **you** sent that match get queued. Nothing from anyone else is
ever touched.

---

## Step 3 — Scan

```bash
python3 scan.py
```

This writes **`tasks.json`** — the list of threads and exact messages to clean —
and prints a summary so you can sanity-check before touching anything:

```
Threads: 42   Messages to clean up: 137
Top threads:
   28  Group chat with the guys
   19  Alex Rivera
   ...
```

Re-run any time you tweak `words.txt`.

---

## Step 4 — Clean up

```bash
npm install          # first time only, installs the browser automation
node unsend.js
```

A browser window opens. **Log into messenger.com** once (your login is
remembered for next time). Then for each conversation the tool shows you what it
found and waits for you to press **Enter** to unsend everything in that thread —
or `s` to skip, or `q` to quit.

Handy options:

```bash
node unsend.js --list        # preview the queue without opening a browser
node unsend.js --smallest    # knock out small threads first (breadth first)
node unsend.js --cap 100     # stop after 100 unsends this session
node unsend.js --auto        # don't ask per thread — full auto
```

It's **resumable**: stop whenever (`q`, or just close it), run it again later and
it picks up where it left off. Progress is saved after every single unsend.

---

## Go slow — seriously

Facebook will temporarily block you if you hammer it. The tool already paces
itself with randomized human-like delays, but you should also:

- Keep sessions to a few hundred unsends a day (`--cap 250` or lower).
- Spread a big cleanup over several days. It resumes automatically.

Unsending is **permanent**, so scan and review your `tasks.json` before you run.

---

## Notes & troubleshooting

- **Encrypted / secret chats.** Newer 1:1 chats are end-to-end encrypted and may
  not be in the standard export. Some people have a separate per-thread Messenger
  download (a zip of JSON files, one per conversation). If you have one, point
  `e2ee_zip` at it in `config.json` and it'll be included too. If not, just leave
  it blank.
- **A thread fails or a button isn't found.** Messenger occasionally changes its
  layout. All the UI strings live in **`selectors.json`** — a failing step will
  drop a screenshot in `failures/` so you can see what changed and update the
  matching selector. PRs welcome.
- **Nothing is uploaded anywhere.** Everything runs locally on your machine. Your
  export, your word list, and your login stay on your computer. `.gitignore`
  keeps all of it out of git.

MIT licensed. Be kind to your past self. 💛
