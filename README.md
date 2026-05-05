# WebCloneAgent

A conversational CLI agent that **clones any website into clean, browser-ready HTML/CSS/JS files** — powered by Groq's Llama 4 Scout with native tool-calling.

```
┌──────────────────────────────────────────────────────────┐
│ WebCloneAgent  ·  conversational website cloner          │
│ Powered by Groq · Llama 4 Scout · tool-calling agent     │
└──────────────────────────────────────────────────────────┘

  Try: clone https://stripe.com
  Or:  /help for commands · /exit to quit

you ›
```

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Add your Groq API key
echo 'GROQ_API_KEY="gsk_..."' > .env

# 3. Run
node index.js
```

Then at the prompt:

```
you › clone https://stripe.com
```

Output lands in `./website-clone/` — open `index.html` in any browser or type `/open`.

---

## CLI Commands

| Command | Description |
|---|---|
| `clone <url>` | Clone a website into `./website-clone/` |
| `/help` | Show all commands |
| `/files` | List files currently in `./website-clone/` |
| `/open` | Open `./website-clone/index.html` in your browser |
| `/clear` | Clear the terminal screen |
| `/exit` | Quit (also: `exit`, `quit`, `q`) |

Anything else typed at the prompt is sent as a free-form instruction to the agent.

---

## Agent Loop & Reasoning

WebCloneAgent uses a **multi-round, tool-calling agent loop** built on top of the Groq Chat Completions API. Each "turn" is a full LLM inference call; the model decides which tool to invoke and the host executes it.

### Loop Architecture

```
User Input
    │
    ▼
┌─────────────────────────────────────────┐
│  isCloneWebsiteCommand(input)?          │
│  → selects cloneTools (minimal set)     │
│  → sets max_tokens: 8000 per call       │
│  → clears stale ./website-clone/        │
└──────────────┬──────────────────────────┘
               │
               ▼  (inner loop)
    ┌──────────────────────┐
    │  Groq API call        │◄──────────────────────────┐
    │  (with retry logic)   │                           │
    └──────────┬────────────┘                           │
               │                                        │
    ┌──────────▼────────────┐                           │
    │  tool_calls present?  │─── No ──► hasCloneDeliverable()?
    └──────────┬────────────┘              │        │
               │ Yes                     Done    Missing → push
               ▼                                  AUTONOMY REMINDER
    ┌──────────────────────┐                      back into messages
    │  executeToolCall()    │
    │  dispatch by name     │
    └──────────┬────────────┘
               │
               ▼
    ┌──────────────────────┐
    │  hasCloneDeliverable? │
    │  → earlyCheck         │
    └──────────┬────────────┘
               │ Not done
               ▼
    Push AUTONOMY REMINDER ──────────────────────────────┘
    into messages, continue loop
```

### Clone Workflow (6 Rounds)

The system prompt instructs the model to follow this exact sequence — one tool call per round:

| Round | Tool | Purpose |
|-------|------|---------|
| 1 | `fetch_to_file` | Download full page HTML to `website-clone/_source.html` |
| 2 | `extract_clone_blueprint` | Analyze HTML → extract nav labels, headings, paragraphs, color palette, font links, theme color |
| 3 | `fetch_linked_css` *(optional)* | Fetch the site's real stylesheet(s) for actual font-family and CSS variable values |
| 4 | `rg` *(optional)* | Grep the source for any specific phrase or pattern not caught by the blueprint |
| 5a | `write_file` | Write `styles.css` — `:root` vars from extracted palette, header, `.hero`, footer, `@media` |
| 5b | `write_file` | Write `index.html` — real nav labels, headings, paragraphs from blueprint, no placeholders |
| 5c | `write_file` | Write `scripts.js` — hamburger toggle, smooth scroll, scroll-shadow on header |
| 6 | `glob` | Confirm all three files exist, then close |

### Autonomy & Self-Correction

After every tool-call batch, `hasCloneDeliverable()` runs a programmatic validator against the output files. If anything is missing or too short, the host **automatically injects an `AUTONOMY REMINDER`** (or `STRICT FIX REQUIRED` after exhausted retries) as a system message into the conversation — no user input needed. The loop continues until all checks pass or the retry budget (`CLONE_AUTONOMY_MAX_RETRIES = 8`) is exhausted.

### Error Recovery

| Error | Recovery strategy |
|---|---|
| HTTP 413 / "Request too large" | Shrink recent tool messages to 2000 chars each, inject warning, retry |
| HTTP 400 `tool_use_failed` | Inject instruction to use single-quoted HTML attrs or `shell` fallback, retry |
| HTTP 400 "generation exceeded max tokens" | Inject instruction to write ONE file at a time, retry |
| HTTP 429 rate-limit | Parse Groq's `"try again in Xm Ys"` message, sleep exact duration + 2 s buffer, retry |

Additionally, `max_tokens: 8000` is set on every clone API call, which hard-caps output at ~6,000 words per response and prevents the 64k token overflow at the source.

---

## Quality of Cloned Website

### What Gets Extracted

`extractCloneBlueprint` performs a pure, zero-default analysis of the downloaded HTML and returns:

| Field | Source | Used for |
|---|---|---|
| `title` / `ogSiteName` | `<title>`, `og:site_name` meta | `<title>` in cloned HTML |
| `metaDescription` | `<meta name="description">` | Footer tagline |
| `themeColor` | `<meta name="theme-color">` | Accent / header color hint |
| `navItems` | `<a>` text, ALL-CAPS text patterns | Navigation links |
| `headings` | `<h1>`–`<h3>` content | Hero h1, section h2s |
| `paragraphs` | `<p>` content (20–260 chars) | Hero subtext, section copy |
| `buttonTexts` | `<button>` content | CTA button labels |
| `colorHexes` | All `#rgb`/`#rrggbb` in HTML (incl. Tailwind bracket syntax) | Palette input |
| `cssVariables` | All `--var-name` occurrences | Passed to model verbatim |
| `gradients` | `linear-gradient(...)` occurrences | Hero background |
| `palette` | Luminance/chroma-grouped hex values | `:root` CSS variable values |
| `linkedStylesheets` | `<link rel="stylesheet">` hrefs | Stylesheet resolution |
| `fontLinks` | Google Fonts / TypeKit URLs | `@import` or `<link>` in cloned head |
| `logoSrc` | `<img>` with "logo" in class/id/alt/src | Logo source hint |

### Color Palette Algorithm

Extracted hex colors are automatically classified into named roles using perceptual luminance (`0.2126R + 0.7152G + 0.0722B`) and chroma (`max−min` of RGB channels):

```
L < 0.18 and C < 0.20  →  darkest    (dark backgrounds, text)
L > 0.86 and C < 0.10  →  lightest   (page background, cards)
L > 0.70 and L < 0.92  →  light      (borders, subtle fills)
C > 0.18 and L < 0.78:
  R > G > B             →  warmAccent (orange/amber brands)
  B > G > R             →  coolAccent (blue/purple brands)
  else                  →  accent     (green, teal, etc.)
```

No fallback colors are hardcoded — if a palette slot is empty the model is instructed to derive it from a present slot (e.g. darken `accent` for `headerBg`).

### Output Quality Requirements (Validator)

`hasCloneDeliverable()` enforces a minimum quality bar before declaring success:

| File | Minimum | Structural checks |
|---|---|---|
| `index.html` | 800 chars | `<header>`, `.hero` section, `<footer>`, ≥ 5 `<a>` links, `styles.css` linked, `scripts.js` linked |
| `styles.css` | 600 chars | `header {}`, `.hero {}`, `footer {}`, `@media` block, ≥ 5 color tokens |
| `scripts.js` | 80 chars | — |

The autonomy loop will keep retrying until all checks pass, telling the model exactly which items are still missing.

---

## Code Quality & Documentation

### Project Structure

```
CursorCLIAssignment/
├── index.js              # Entry point — imports and calls runAgent()
├── agent.js              # Core agent loop, tool definitions, system prompt
└── tools/
    ├── web.js            # webFetch, fetchToFile, extractCloneBlueprint, fetchLinkedCss
    ├── file.js           # readFile, readFileSegment, writeFile
    ├── search.js         # glob (fast-glob), rg (ripgrep via execa)
    ├── browser.js        # Puppeteer-backed browser_navigate/snapshot/screenshot/click/scroll
    ├── patch.js          # apply_patch (unified diff via the `diff` package)
    ├── shell.js          # shell() — executes arbitrary shell commands via execa
    ├── lints.js          # read_lints — runs ESLint, returns errors/warnings
    ├── image.js          # generate_image — placeholder image generator
    └── ui.js             # ANSI colors, banner, spinner, printToolCall, parseSlashCommand
```

### Key Design Decisions

**Separate tool sets per task mode**
Clone tasks use `cloneTools` (6 focused tools: `fetch_to_file`, `extract_clone_blueprint`, `fetch_linked_css`, `rg`, `write_file`, `glob`, `shell`). General chat uses the full `tools` set including browser, lint, and image tools. This prevents the model from reaching for irrelevant tools during a clone — keeping rounds short and focused.

**Token budget management**
- `max_tokens: 8000` is applied only to clone calls — enough for any single file, impossible to overflow Groq's 64k output limit.
- `truncateToolResult()` caps each tool reply before it enters the message history (e.g. `extract_clone_blueprint` ≤ 12,000 chars, `rg` ≤ 12,000, everything else ≤ 6,000–8,000).
- `shrinkRecentToolMessages()` is a last-resort emergency truncator that fires on HTTP 413 (input too large).

**Defensive JSON parsing**
Tool call arguments are always parsed with a try/catch. On parse failure the host injects an error `tool` message instead of crashing, allowing the model to self-correct.

**Model override via env**
`GROQ_MODEL` environment variable lets you swap the underlying model without touching code:
```bash
GROQ_MODEL=llama-3.3-70b-versatile node index.js
```

**No external CLI framework**
The UI (`tools/ui.js`) uses only Node's built-in `readline` and raw ANSI escape codes — zero runtime overhead, works in any terminal. The spinner respects `NO_COLOR=1` and non-TTY stdout (CI pipes).

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `GROQ_API_KEY` | ✅ | — | Your Groq API key |
| `GROQ_MODEL` | ❌ | `meta-llama/llama-4-scout-17b-16e-instruct` | Groq model ID to use |
| `NO_COLOR` | ❌ | — | Set to `1` to disable ANSI colors |

### Dependencies

| Package | Purpose |
|---|---|
| `groq-sdk` | Groq Chat Completions API client |
| `dotenv` | `.env` file loading |
| `node-fetch` | HTTP fetching for `webFetch` / `fetchToFile` / `fetchLinkedCss` |
| `fast-glob` | `glob()` tool implementation |
| `execa` | Shell command execution for `rg` and `shell` tools |
| `diff` | Unified diff parsing for `apply_patch` |
| `puppeteer` | Headless browser for `browser_*` tools |
| `open` | Opens `index.html` in the system browser (`/open` command) |

---

## License

MIT
