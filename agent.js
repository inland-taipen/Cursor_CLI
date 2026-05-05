import "dotenv/config";
import fs from "fs/promises";
import path from "node:path";
import { Groq } from "groq-sdk";
import readline from "readline";

import * as browser from "./tools/browser.js";
import * as file from "./tools/file.js";
import * as search from "./tools/search.js";
import * as patch from "./tools/patch.js";
import * as shell from "./tools/shell.js";
import * as lints from "./tools/lints.js";
import * as web from "./tools/web.js";
import * as image from "./tools/image.js";
import {
  c,
  printBanner,
  printHelp,
  printAssistant,
  printError,
  printRound,
  printDone,
  printToolCall,
  printPrompt,
  parseSlashCommand,
  clearScreen,
  spinner
} from "./tools/ui.js";

const client = new Groq({ apiKey: process.env.GROQ_API_KEY });

/** Groq model ID; defaults to Llama 4 Scout for stable native tool_calls. Set GROQ_MODEL to override. */
const GROQ_MODEL = process.env.GROQ_MODEL ?? "meta-llama/llama-4-scout-17b-16e-instruct";

const CLONE_AUTONOMY_MAX_RETRIES = 8;

function isCloneWebsiteCommand(text) {
  return /clone\s+https?:\/\//i.test(String(text).trim());
}

async function hasCloneDeliverable(cwd = process.cwd()) {
  const dir = path.join(cwd, "website-clone");
  const missing = [];

  let html = "";
  try {
    html = await fs.readFile(path.join(dir, "index.html"), "utf-8");
    const t = html.trim();
    if (t.length < 800) missing.push(`website-clone/index.html too short (${t.length} chars, need 800+)`);
    const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? "";
    if (!body.trim()) missing.push("index.html: missing non-empty <body>...</body>");
    if (!/\<header[\s>]/i.test(body)) missing.push("index.html: missing <header> inside <body>");
    if (!/\<footer[\s>]/i.test(body)) missing.push("index.html: missing <footer> inside <body>");
    const hasHero =
      /\bhero\b/i.test(body) ||
      /class=['"][^'"]*hero[^'"]*['"]/i.test(body) ||
      /<section[^>]*hero/i.test(body);
    if (!hasHero) missing.push("index.html: add a hero section inside <body>");
    const linkCount = (body.match(/<a\b[^>]*>/gi) || []).length;
    if (linkCount < 5) missing.push("index.html: add at least 5 nav/content links");
    if (!/<link[^>]+styles\.css/i.test(html)) missing.push("index.html: link styles.css in <head>");
    if (!/scripts\.js/i.test(html)) missing.push("index.html: link scripts.js via <script src='scripts.js' defer></script>");
  } catch {
    missing.push("website-clone/index.html is missing");
  }

  try {
    const css = await fs.readFile(path.join(dir, "styles.css"), "utf-8");
    if (css.trim().length < 600) missing.push(`website-clone/styles.css too short (${css.trim().length} chars, need 600+)`);
    if (!/header\s*\{/i.test(css)) missing.push("styles.css: add header selector styling");
    if (!/\.hero\s*\{/i.test(css)) missing.push("styles.css: add .hero selector styling");
    if (!/footer\s*\{/i.test(css)) missing.push("styles.css: add footer selector styling");
    if (!/@media/i.test(css)) missing.push("styles.css: add @media (max-width:768px) responsive block");
    const colorTokens =
      (css.match(/#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g) || []).length +
      (css.match(/--[a-z0-9-]+/gi) || []).length;
    if (colorTokens < 5) missing.push("styles.css: include at least 5 color tokens (hex values and/or CSS vars)");
  } catch {
    missing.push("website-clone/styles.css is missing");
  }

  try {
    const js = await fs.readFile(path.join(dir, "scripts.js"), "utf-8");
    if (js.trim().length < 80) missing.push(`website-clone/scripts.js too short (${js.trim().length} chars, need 80+)`);
  } catch {
    missing.push("website-clone/scripts.js is missing");
  }

  return { done: missing.length === 0, missing };
}

// --- Tool definitions ---
const writeTool = {
  type: "function",
  function: {
    name: "write_file",
    description: "Create or overwrite a file (creates parent directories). Use single-quoted HTML attributes in content.",
    parameters: {
      type: "object",
      properties: { filePath: { type: "string" }, content: { type: "string" } },
      required: ["filePath", "content"]
    }
  }
};

/** Minimal tool set for clone tasks — strips browser, lint, image tools so model cannot drift. */
const cloneTools = [
  {
    type: "function",
    function: {
      name: "fetch_to_file",
      description: "Download a URL to a local file (full bytes). Use ONCE: fetch_to_file url=<target> filePath=website-clone/_source.html",
      parameters: {
        type: "object",
        properties: { url: { type: "string" }, filePath: { type: "string" } },
        required: ["url", "filePath"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "extract_clone_blueprint",
      description:
        "Analyze downloaded HTML and return RAW extracted facts: title, ogSiteName, metaDescription, navItems, headings, paragraphs, buttonTexts, colorHexes, cssVariables, gradients, palette, linkedStylesheets (href URLs of <link rel=stylesheet>), fontLinks (Google Fonts / TypeKit @import or <link> URLs), themeColor (<meta name=theme-color>), logoSrc (first img with logo in class/id/alt/src). No site-specific defaults.",
      parameters: {
        type: "object",
        properties: { sourceFilePath: { type: "string" } },
        required: ["sourceFilePath"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "fetch_linked_css",
      description:
        "Fetch the real CSS files linked in the downloaded source HTML. Reads <link rel='stylesheet'> href values, resolves them against the base URL, fetches up to 3 of them, and returns their combined content (truncated to ~8000 chars). Use this after extract_clone_blueprint to get real font-family declarations, spacing values, and brand color tokens that may not appear as hex literals in the HTML.",
      parameters: {
        type: "object",
        properties: {
          sourceFilePath: { type: "string", description: "Path to the downloaded _source.html" },
          baseUrl: { type: "string", description: "The original page URL, used to resolve relative stylesheet hrefs" }
        },
        required: ["sourceFilePath", "baseUrl"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "rg",
      description: "Search the downloaded source file for text. Pattern is a regex. Example patterns: '<h[12][^>]*>([^<]+)' for headings, '#[0-9a-fA-F]{6}' for hex colors.",
      parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] }
    }
  },
  writeTool,
  {
    type: "function",
    function: {
      name: "glob",
      description: "Verify files exist after writing (e.g. pattern: website-clone/*.{html,css,js}).",
      parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] }
    }
  },
  {
    type: "function",
    function: {
      name: "shell",
      description: "Run a shell command (fallback: write files via node -e if write_file JSON fails).",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] }
    }
  }
];

/** Full tool set for general (non-clone) tasks. */
const tools = [
  {
    type: "function",
    function: {
      name: "browser_navigate",
      description: "Navigate the browser to a URL",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] }
    }
  },
  {
    type: "function",
    function: {
      name: "browser_snapshot",
      description: "Get accessibility snapshot of current page",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "browser_take_screenshot",
      description: "Take a screenshot of the current page",
      parameters: { type: "object", properties: { path: { type: "string" } } }
    }
  },
  {
    type: "function",
    function: {
      name: "browser_click",
      description: "Click an element by CSS selector",
      parameters: { type: "object", properties: { selector: { type: "string" } }, required: ["selector"] }
    }
  },
  {
    type: "function",
    function: {
      name: "browser_scroll",
      description: "Scroll the page by a number of pixels",
      parameters: { type: "object", properties: { distance: { type: "number" } }, required: ["distance"] }
    }
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a small file from disk.",
      parameters: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] }
    }
  },
  {
    type: "function",
    function: {
      name: "read_file_segment",
      description: "Read part of a UTF-8 file by character offset and length (max ~6000 chars).",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string" },
          offset: { type: "number" },
          length: { type: "number" }
        },
        required: ["filePath"]
      }
    }
  },
  writeTool,
  {
    type: "function",
    function: {
      name: "glob",
      description: "Find files matching a pattern. node_modules and .git are excluded.",
      parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] }
    }
  },
  {
    type: "function",
    function: {
      name: "rg",
      description: "Search file contents with ripgrep",
      parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] }
    }
  },
  {
    type: "function",
    function: {
      name: "apply_patch",
      description: "Apply a unified diff patch to a file",
      parameters: { type: "object", properties: { filePath: { type: "string" }, patchText: { type: "string" } }, required: ["filePath", "patchText"] }
    }
  },
  {
    type: "function",
    function: {
      name: "shell",
      description: "Run a shell command",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] }
    }
  },
  {
    type: "function",
    function: {
      name: "read_lints",
      description: "Get ESLint errors/warnings for the project",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Fetch HTML/text from a URL (first ~8000 chars inline).",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] }
    }
  },
  {
    type: "function",
    function: {
      name: "fetch_to_file",
      description: "Download a URL response body to a project file (full bytes, no truncation).",
      parameters: {
        type: "object",
        properties: { url: { type: "string" }, filePath: { type: "string" } },
        required: ["url", "filePath"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "extract_clone_blueprint",
      description:
        "Analyze downloaded HTML and return RAW extracted facts (nav labels, headings, paragraphs, colors, css variables, gradients, luminance-grouped palette). No site-specific defaults.",
      parameters: {
        type: "object",
        properties: { sourceFilePath: { type: "string" } },
        required: ["sourceFilePath"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "generate_image",
      description: "Generate a placeholder image",
      parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] }
    }
  }
];

// --- System prompt that tells the agent how to clone a website ---
const SYSTEM_PROMPT = `
You are WebCloneAgent: a conversational CLI agent that produces faithful, visually rich front-end clones from a user's instruction.

TOOL RULES:
- Use native tool_calls only. Never imitate tools in plain text.
- write_file content must be valid JSON — use single-quoted HTML attributes.
- Write ONE file per response to stay under the 64k output token limit.

CLONE TASK ("clone <url>"):
Goal: produce 3 files in ./website-clone/ that look unmistakably like the real site — correct brand colors, real fonts, real copy, proper layout hierarchy.

REQUIRED FILES (validator checks these):
1. website-clone/index.html  ≥ 800 chars   <link rel='stylesheet' href='styles.css'> in <head>; <body> must have <header>, hero section (class='hero'), <footer>, <script src='scripts.js' defer></script>, ≥ 5 <a> links.
2. website-clone/styles.css  ≥ 600 chars   must have: :root color/font variables, header { }, .hero { }, footer { }, ≥ 5 color tokens, @media (max-width:768px) block.
3. website-clone/scripts.js  ≥ 80 chars    real interaction: hamburger toggle + smooth scroll + scroll-shadow on header.

WORKFLOW — follow this exactly, one tool call per round:

ROUND 1 — Fetch the page source:
  fetch_to_file(url=<target>, filePath='website-clone/_source.html')

ROUND 2 — Extract the visual blueprint:
  extract_clone_blueprint(sourceFilePath='website-clone/_source.html')
  This returns: title, ogSiteName, metaDescription, navItems, headings, paragraphs, buttonTexts,
  colorHexes, cssVariables, gradients, palette, linkedStylesheets, fontLinks, themeColor, logoSrc.

ROUND 3 — Fetch real CSS from the site's own stylesheets:
  fetch_linked_css(sourceFilePath='website-clone/_source.html', baseUrl=<the original url>)
  Scan the returned CSS for: font-family declarations, --custom-property values, spacing/sizing tokens.
  If fontLinks from step 2 included a Google Fonts URL, note the font name for use in styles.css.

ROUND 4 — (optional) Use rg to search _source.html for any missing detail:
  e.g. rg(pattern='font-family:[^;]+', path='website-clone/_source.html') or for specific text.
  Skip this round if you already have everything from rounds 2 and 3.

ROUND 5a — write_file: styles.css (aim for 600–900 chars; stop after this call):
  :root {
    /* All colors from blueprint.palette as CSS vars, filled with real hex values */
    /* Font stack from fetch_linked_css — if Google Fonts found, add @import at top */
  }
  body { font-family: var(--font); background: var(--pageBg); color: var(--textColor); margin:0; }
  header { position: sticky; top:0; z-index:100; background: var(--headerBg); /* brand color */ }
  nav a { color: var(--navText); text-decoration:none; transition: opacity .2s; }
  nav a:hover { opacity:.75; }
  .hero { min-height:70vh; display:flex; flex-direction:column; justify-content:center; padding:4rem 2rem;
    background: var(--heroBg); /* use gradient from blueprint if available */ }
  .hero h1 { font-size:clamp(2rem,5vw,3.5rem); margin:0 0 1rem; }
  .section { padding:4rem 2rem; max-width:1100px; margin:0 auto; }
  footer { background: var(--footerBg); color: var(--footerText); padding:2rem; text-align:center; }
  .btn { display:inline-block; padding:.75rem 1.5rem; border-radius:6px;
    background:var(--accent); color:#fff; text-decoration:none; transition:opacity .2s; }
  .btn:hover { opacity:.85; }
  @media (max-width:768px) {
    .hero { min-height:50vh; }
    nav .nav-links { display:none; flex-direction:column; }
    nav .nav-links.open { display:flex; }
  }

ROUND 5b — write_file: index.html (aim for 800–1400 chars; stop after this call):
  <head>: <meta charset='UTF-8'>, <meta name='viewport' content='width=device-width,initial-scale=1'>,
    <title> from ogSiteName/title, <link rel='stylesheet' href='styles.css'>,
    if Google Fonts found → <link rel='preconnect' href='https://fonts.googleapis.com'> + <link href='...' rel='stylesheet'>.
  <body>:
    <header><nav> with logo text (ogSiteName) + <ul class='nav-links'> using blueprint.navItems as <li><a> items + <button class='hamburger'>☰</button></header>
    <section class='hero' id='hero'>: <h1> from headings[0], <p> from paragraphs[0], CTA <a class='btn'> from buttonTexts[0]
    2–3 <section class='section'>: each with <h2> + <p> from subsequent headings/paragraphs
    <footer>: brand name + short tagline from metaDescription or paragraphs
    <script src='scripts.js' defer></script>
  Rules: single-quoted attrs only; no "Link 1"/"placeholder" text; use real content from blueprint.

ROUND 5c — write_file: scripts.js (aim for 80–200 chars; stop after this call):
  const burger = document.querySelector('.hamburger');
  const navLinks = document.querySelector('.nav-links');
  burger?.addEventListener('click', () => navLinks.classList.toggle('open'));
  document.querySelectorAll('a[href^="#"]').forEach(a =>
    a.addEventListener('click', e => { e.preventDefault();
      document.querySelector(a.getAttribute('href'))?.scrollIntoView({behavior:'smooth'}); }));
  window.addEventListener('scroll', () =>
    document.querySelector('header').style.boxShadow = scrollY > 10 ? '0 2px 12px rgba(0,0,0,.15)' : 'none');

ROUND 6 — glob website-clone/*.{html,css,js} to confirm, then one closing line.

DESIGN FIDELITY RULES:
- Every color in :root must come from blueprint.palette or fetch_linked_css — never invent colors.
- Every font-family must come from fetch_linked_css or blueprint.fontLinks — never default to Arial.
- Every text string (nav labels, headings, paragraphs) must come from blueprint — never use generic copy.
- Derive missing palette slots from present ones (e.g. darken accent for headerBg, lighten for border).
- The hero background should use blueprint.gradients[0] if one was found, else a solid blueprint color.
`;

function truncateToolResult(toolName, result) {
  // Groq on_demand tier rejects whole requests ~30k tokens; keep each tool reply small.
  const limits = {
    read_file: 8000,
    read_file_segment: 8000,
    web_fetch: 8000,
    extract_clone_blueprint: 12000,
    fetch_linked_css: 8000,
    browser_snapshot: 12_000,
    rg: 12_000,
    glob: 8000,
    read_lints: 8000,
    default: 6000
  };
  const max = limits[toolName] ?? limits.default;
  const s = String(result);
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n...[truncated ${s.length - max} more chars]`;
}

function shrinkRecentToolMessages(messages, maxChars = 2000, maxToolMsgs = 12) {
  let seen = 0;
  for (let i = messages.length - 1; i >= 0 && seen < maxToolMsgs; i--) {
    const m = messages[i];
    if (m.role !== "tool") continue;
    seen++;
    const c = m.content;
    if (typeof c === "string" && c.length > maxChars) {
      messages[i] = {
        ...m,
        content: `${c.slice(0, maxChars)}\n...[emergency truncated from ${c.length} chars]`
      };
    }
  }
}

function isRequestTooLarge(err) {
  return err?.status === 413 || String(err?.message ?? "").includes("Request too large");
}

// --- Tool dispatcher ---
async function executeToolCall(toolName, args) {
  switch (toolName) {
    case "browser_navigate": return await browser.browserNavigate(args.url);
    case "browser_snapshot": return await browser.browserSnapshot();
    case "browser_take_screenshot": return await browser.browserTakeScreenshot(args.path);
    case "browser_click": return await browser.browserClick(args.selector);
    case "browser_scroll": return await browser.browserScroll(args.distance);
    case "read_file": return await file.readFile(args.filePath);
    case "read_file_segment":
      return await file.readFileSegment(args.filePath, args.offset, args.length);
    case "write_file": return await file.writeFile(args.filePath, args.content);
    case "glob": return await search.glob(args.pattern);
    case "rg": return await search.rg(args.pattern, args.path);
    case "apply_patch": return await patch.applyPatch(args.filePath, args.patchText);
    case "shell": return await shell.shell(args.command);
    case "read_lints": return await lints.readLints();
    case "web_fetch": return await web.webFetch(args.url);
    case "fetch_to_file": return await web.fetchToFile(args.url, args.filePath);
    case "extract_clone_blueprint": return await web.extractCloneBlueprint(args.sourceFilePath);
    case "fetch_linked_css": return await web.fetchLinkedCss(args.sourceFilePath, args.baseUrl);
    case "generate_image": return await image.generateImage(args.prompt);
    default: return `Unknown tool: ${toolName}`;
  }
}

function isGroqToolUseFailed(err) {
  const code = err?.error?.error?.code ?? err?.error?.code;
  return (
    err?.status === 400 &&
    (code === "tool_use_failed" || String(err?.message ?? "").includes("tool_use_failed"))
  );
}

/** Groq returns HTTP 400 with this phrase when the *output* would exceed 64k tokens. */
function isMaxTokensError(err) {
  return (
    err?.status === 400 &&
    String(err?.error?.error?.message ?? err?.message ?? "").includes("generation exceeded max tokens limit")
  );
}

function isRateLimitError(err) {
  return err?.status === 429;
}

function parseRetryAfterMs(err) {
  // Groq embeds "Please try again in Xm Ys" or "in Xs" in the message
  const msg = String(err?.error?.error?.message ?? err?.message ?? "");
  const match = msg.match(/try again in (?:(\d+)m)?(\d+(?:\.\d+)?)s/i);
  if (!match) return 62_000; // default 62s if we can't parse
  const mins = parseFloat(match[1] || "0");
  const secs = parseFloat(match[2] || "0");
  return Math.ceil((mins * 60 + secs) * 1000) + 2000; // +2s buffer
}

async function chatCompletionCreateWithToolRetry(client, baseParams, messages, maxAttempts = 6) {
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await client.chat.completions.create({ ...baseParams, messages });
    } catch (err) {
      lastErr = err;
      if (isRequestTooLarge(err) && attempt < maxAttempts - 1) {
        shrinkRecentToolMessages(messages, 2000, 14);
        messages.push({
          role: "user",
          content:
            "The last API request was too large (context/token limit). Recent tool outputs were shortened in this transcript. Continue using rg and read_file_segment with length 3000–4000 only; never read the full _source.html in one tool."
        });
        continue;
      }
      if (isMaxTokensError(err) && attempt < maxAttempts - 1) {
        // Model tried to generate too much in one shot (e.g. all 3 files at once).
        // Ask it to write files one at a time so each response stays under 64k tokens.
        messages.push({
          role: "user",
          content:
            "Your last response was too long and exceeded Groq's 64 000-token output limit. " +
            "Write only ONE file per tool call from now on. " +
            "First call write_file for styles.css only. Then stop and wait. " +
            "Do NOT write index.html or scripts.js in this turn."
        });
        continue;
      }
      if (isGroqToolUseFailed(err) && attempt < maxAttempts - 1) {
        messages.push({
          role: "user",
          content:
            "Groq rejected the last reply: invalid tool-call JSON (often unescaped double quotes inside HTML for write_file). Retry with: (1) write_file using HTML that uses only single-quoted attributes, or (2) a tiny write_file then apply_patch hunks, or (3) shell running node -e with a template literal to write the file. Use valid JSON in tool arguments only."
        });
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

async function readUserLine(rl) {
  return new Promise((resolve) => {
    if (rl.closed) return resolve("exit");
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      rl.off("close", onClose);
      resolve(value);
    };
    const onClose = () => finish("exit");
    rl.once("close", onClose);
    try {
      rl.question("\n" + printPrompt(), (answer) => finish(answer ?? ""));
    } catch {
      finish("exit");
    }
  });
}

async function listClonedFiles() {
  try {
    const dir = path.join(process.cwd(), "website-clone");
    const entries = await fs.readdir(dir);
    const out = [];
    for (const name of entries) {
      try {
        const stat = await fs.stat(path.join(dir, name));
        if (stat.isFile()) out.push({ path: `website-clone/${name}`, size: stat.size });
      } catch { /* ignore */ }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  } catch {
    return [];
  }
}

async function openIndexInBrowser() {
  const target = path.join(process.cwd(), "website-clone", "index.html");
  try {
    await fs.access(target);
  } catch {
    printError("./website-clone/index.html does not exist yet. Run a clone first.");
    return;
  }
  try {
    const open = (await import("open")).default;
    await open(target);
    console.log(c.gray("    Opened ") + c.cyan(target));
  } catch (err) {
    printError(`Could not open in browser: ${err?.message ?? err}`);
  }
}

// --- Main agent loop ---
export async function runAgent() {
  const messages = [{ role: "system", content: SYSTEM_PROMPT }];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  printBanner();

  while (true) {
    const userInput = (await readUserLine(rl)).trim();

    const slash = parseSlashCommand(userInput);
    if (slash?.kind === "exit") break;
    if (slash?.kind === "noop") continue;
    if (slash?.kind === "help") { printHelp(); continue; }
    if (slash?.kind === "clear") { clearScreen(); printBanner(); continue; }
    if (slash?.kind === "files") {
      const files = await listClonedFiles();
      if (!files.length) console.log(c.gray("    (no files in ./website-clone/ yet)"));
      else for (const f of files) console.log(c.gray("    · ") + c.cyan(f.path) + c.gray(`  (${f.size} bytes)`));
      continue;
    }
    if (slash?.kind === "open") { await openIndexInBrowser(); continue; }

    messages.push({ role: "user", content: userInput });

    const cloneWebsiteTask = isCloneWebsiteCommand(userInput);
    let cloneAutonomyRetries = cloneWebsiteTask ? CLONE_AUTONOMY_MAX_RETRIES : 0;

    // Clear stale clone output so hasCloneDeliverable() won't be fooled by a previous run
    if (cloneWebsiteTask) {
      try {
        await fs.rm(path.join(process.cwd(), "website-clone"), { recursive: true, force: true });
        await fs.mkdir(path.join(process.cwd(), "website-clone"), { recursive: true });
      } catch { /* ignore */ }
      console.log(c.gray("\n  Cloning ") + c.bold(userInput.replace(/^clone\s+/i, "")) + c.gray(" → ./website-clone/"));
    }

    // Inner loop for tool calling (agent may call multiple tools in one turn)
    let toolCallsPending = true;
    let roundN = 0;
    while (toolCallsPending) {
      roundN++;
      printRound(roundN, cloneWebsiteTask ? "fetch · extract · write" : "thinking");

      const stopSpinner = spinner(cloneWebsiteTask ? "calling Groq…" : "thinking…");
      let response;
      try {
        response = await chatCompletionCreateWithToolRetry(
          client,
          {
            model: GROQ_MODEL,
            tools: cloneWebsiteTask ? cloneTools : tools,
            tool_choice: "auto",
            // Hard cap per-response tokens for clone tasks — prevents "generation exceeded max tokens" (64k limit).
            // 8000 tokens ≈ 6000 words, more than enough for one CSS/HTML/JS file.
            ...(cloneWebsiteTask ? { max_tokens: 8000 } : {})
          },
          messages
        );
      } catch (err) {
        stopSpinner();
        printError(err?.message ?? String(err));
        toolCallsPending = false;
        break;
      }
      stopSpinner();

      const assistantMsg = response.choices[0].message;
      messages.push({
        role: "assistant",
        content: assistantMsg.content ?? null,
        ...(assistantMsg.tool_calls?.length
          ? { tool_calls: assistantMsg.tool_calls }
          : {})
      });

      if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
        for (const toolCall of assistantMsg.tool_calls) {
          let args = {};
          try {
            const raw = toolCall.function.arguments;
            args = raw && String(raw).trim() ? JSON.parse(raw) : {};
          } catch {
            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              name: toolCall.function.name,
              content: "Invalid JSON in tool arguments; use valid JSON objects only."
            });
            continue;
          }
          printToolCall(toolCall.function.name, args);
          const result = await executeToolCall(toolCall.function.name, args);
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            name: toolCall.function.name,
            content: truncateToolResult(toolCall.function.name, result)
          });
        }

        if (cloneWebsiteTask) {
          const earlyCheck = await hasCloneDeliverable();
          if (earlyCheck.done) {
            printDone(await listClonedFiles());
            toolCallsPending = false;
            break;
          }
          if (cloneAutonomyRetries > 0) {
            cloneAutonomyRetries--;
            messages.push({
              role: "system",
              content:
                `AUTONOMY REMINDER: Not done yet. Still missing:\n` +
                earlyCheck.missing.map(m => `  - ${m}`).join("\n") +
                `\n\nKeep calling tools. Fix what is missing. Use write_file with single-quoted HTML attributes only.`
            });
          } else {
            cloneAutonomyRetries = 3;
            messages.push({
              role: "system",
              content:
                `STRICT FIX REQUIRED: clone still invalid.\n` +
                earlyCheck.missing.map(m => `  - ${m}`).join("\n") +
                `\n\nDo NOT end with text. Make corrective write_file calls now until all missing items are fixed.`
            });
          }
        }

        continue;
      }

      const deliverable = cloneWebsiteTask ? await hasCloneDeliverable() : { done: true };
      if (cloneWebsiteTask && deliverable.done) {
        printDone(await listClonedFiles());
        toolCallsPending = false;
      } else if (cloneWebsiteTask && cloneAutonomyRetries > 0 && !deliverable.done) {
        cloneAutonomyRetries--;
        messages.push({
          role: "system",
          content:
            `AUTONOMY REMINDER: The clone is NOT complete yet. Still missing:\n` +
            deliverable.missing.map(m => `  - ${m}`).join("\n") +
            `\n\nKeep calling tools only—do NOT send a text response yet. ` +
            `Fix what is missing above. Use write_file with only single-quoted HTML attributes. No questions.`
        });
        continue;
      } else if (cloneWebsiteTask && !deliverable.done) {
        cloneAutonomyRetries = 3;
        messages.push({
          role: "system",
          content:
            `STRICT FIX REQUIRED: clone still invalid.\n` +
            deliverable.missing.map(m => `  - ${m}`).join("\n") +
            `\n\nDo NOT send a user-facing message yet. Make corrective write_file calls now.`
        });
        continue;
      } else {
        printAssistant(assistantMsg.content);
        toolCallsPending = false;
      }
    }
  }
  console.log(c.gray("\n  Goodbye 👋"));
  if (!rl.closed) rl.close();
}