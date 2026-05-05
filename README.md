# ScalerCloneAgent

A conversational CLI agent that **clones the Scaler Academy website into clean, browser-ready HTML/CSS/JS files** — powered by Groq's Llama 3 70B with native tool-calling.

```
🤖 ScalerCloneAgent - Chat to clone Scaler Academy
Type your instruction (e.g., "clone scaler", or just "start"). Type "exit" to quit.

You:
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
You: start
```

Output lands in `./scaler-clone/` and opens in your browser automatically.

---

## Agent Loop & Reasoning

ScalerCloneAgent uses a **multi-round conversational tool-calling loop** built on the Groq Chat Completions API. Each iteration is a full LLM inference call — the model decides which tool to invoke, the host executes it, and the result is appended to the conversation history before the next call.

### Loop Architecture

```
User Input
    │
    ▼
Push to messages[]
    │
    ▼  (inner agent loop)
┌─────────────────────────────┐
│  groq.chat.completions      │◄──────────────────┐
│  create({ tools, messages })│                   │
└──────────────┬──────────────┘                   │
               │                                  │
    ┌──────────▼────────────┐                     │
    │  tool_calls present?  │── No → print reply  │
    └──────────┬────────────┘      break inner     │
               │ Yes               loop            │
               ▼                                  │
    ┌──────────────────────────┐                  │
    │  Dispatch to             │                  │
    │  TOOL_FUNCTIONS[name]()  │                  │
    └──────────┬───────────────┘                  │
               │                                  │
    Push tool result into messages[]              │
    (role: "tool", tool_call_id)                  │
               │                                  │
               └──────────────────────────────────┘
                       continue loop
```

### Clone Workflow (4 Rounds)

The system prompt instructs the model to follow this exact sequence:

| Round | Tool | Purpose |
|-------|------|---------|
| 1 | `fetchWebpage` | Download full Scaler Academy HTML via axios |
| 2 | `extractDesignTokens` | Parse HTML with cheerio → extract colors, fonts, nav items, headings, CTA buttons, footer |
| 3a | `writeFile` | Write `styles.css` using extracted brand colors as CSS variables |
| 3b | `writeFile` | Write `index.html` using real nav labels, headings, and paragraphs |
| 3c | `writeFile` | Write `scripts.js` — hamburger toggle, smooth scroll, scroll-shadow header |
| 4 | `openInBrowser` | Open `scaler-clone/index.html` in the system browser |

The model writes **one file per response** (`temperature: 0.3`, `max_tokens: 8000`) to stay well within Groq's output token limits.

### Conversation Flow

The loop is fully conversational — after the initial autonomous clone, users can send follow-up instructions:

```
You: make the hero background darker
You: add a pricing section
You: exit
```

Each instruction is appended as a `user` message, and the agent continues calling tools as needed.

---

## Quality of Cloned Website

### What `extractDesignTokens` Extracts

Uses [cheerio](https://cheerio.js.org/) (server-side jQuery) to parse the fetched HTML and return structured design data:

| Field | Cheerio selector | Used for |
|---|---|---|
| `colors` | `[style]` attrs → regex for `#hex` / `rgba()` | CSS `:root` color variables |
| `fontUrls` | `link[href*="font"]`, `link[href*="googleapis"]` | `<link>` tags in cloned `<head>` |
| `navItems` | `nav a`, `header a` (< 30 chars) | Navigation links (up to 6) |
| `heroHeading` | `h1:first` text | Hero `<h1>` |
| `buttons` | `button`, `.btn`, `.cta`, `.hero a` | CTA button labels (up to 3) |
| `footerText` | `footer:first` text (first 300 chars) | Footer content |
| `brand` | `.logo`, `.brand`, `header h1` | Logo / brand name |

### Design Fidelity Rules (System Prompt)

The model is explicitly instructed to:
- Use **exact brand colors** from extracted tokens (dark blue/purple gradients)
- Use **real Scaler copy**: "Explore Programs", "Login", "For Enterprise" — no placeholders
- Add **Google Fonts** `<link>` tags from `fontUrls`
- Write **one file per response** to avoid token overflow

### Output

```
scaler-clone/
├── index.html   # Semantic layout: header, hero, sections, footer
├── styles.css   # :root variables, sticky header, .hero, @media responsive
└── scripts.js   # Hamburger toggle, smooth scroll, header scroll-shadow
```

---

## Code Quality & Documentation

### Project Structure

```
CursorCLIAssignment/
├── index.js        # Entry point — imports and calls runAgent()
├── agent.js        # All-in-one: tools, tool definitions, system prompt, agent loop
└── tools/          # (legacy tool modules from prior architecture)
```

### Key Design Decisions

**Cheerio over regex**
`extractDesignTokens` uses cheerio's jQuery-like API for HTML parsing — more reliable than regex for navigating nested DOM structures like `nav a` or `footer:first`.

**Flat single-file architecture**
All tool implementations, tool definitions, GROQ client, system prompt, and the agent loop live in `agent.js`. This makes the code easy to read top-to-bottom without jumping between modules.

**`max_tokens: 8000` cap**
Set on every API call to hard-prevent Groq's 64k output overflow — a single CSS or HTML file fits comfortably within this budget.

**Tool call argument spreading**
Arguments are spread positionally (`toolFunc(...Object.values(args))`), which works because each tool only requires its own named params in a predictable order.

**Model override**
Swap the model by changing `MODEL` at the top of `agent.js`:
```js
const MODEL = 'mixtral-8x7b-32768'; // alternative
```

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GROQ_API_KEY` | ✅ | Your Groq API key |

### Dependencies

| Package | Purpose |
|---|---|
| `groq-sdk` | Groq Chat Completions API client |
| `axios` | HTTP fetching (`fetchWebpage`) |
| `cheerio` | HTML parsing (`extractDesignTokens`) |
| `chalk` | Terminal color output |
| `ora` | Spinner while waiting for Groq response |
| `fs-extra` | File I/O with `ensureDir`, `writeFile`, `pathExists` |
| `dotenv` | `.env` file loading |

---

## License

MIT
