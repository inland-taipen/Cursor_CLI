/**
 * Lightweight terminal UI helpers — ANSI colors, banner, spinner, command parsing.
 * No external dependencies; safe to disable when stdout is not a TTY.
 */

const ENABLE = process.stdout.isTTY && process.env.NO_COLOR !== "1";

function wrap(open, close) {
  return (s) => (ENABLE ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
}

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  italic: wrap(3, 23),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
  bgCyan: wrap(46, 49),
  bgMagenta: wrap(45, 49)
};

const BOX_INNER_WIDTH = 58;

function visibleLen(s) {
  // strip ANSI escape sequences for width calculation
  return String(s).replace(/\x1b\[[0-9;]*m/g, "").length;
}

function boxLine(content) {
  const pad = Math.max(0, BOX_INNER_WIDTH - visibleLen(content));
  return c.cyan("│") + content + " ".repeat(pad) + c.cyan("│");
}

export function printBanner() {
  const horiz = "─".repeat(BOX_INNER_WIDTH);
  const title =
    " " + c.bold(c.magenta("WebCloneAgent")) + c.gray("  ·  conversational website cloner");
  const subtitle =
    " " + c.dim("Powered by Groq · Llama 4 Scout · tool-calling agent");
  const lines = [
    "",
    c.cyan("┌" + horiz + "┐"),
    boxLine(title),
    boxLine(subtitle),
    c.cyan("└" + horiz + "┘"),
    "",
    c.gray("  Try: ") + c.bold("clone https://stripe.com"),
    c.gray("  Or:  ") + c.bold("/help") + c.gray(" for commands · ") + c.bold("/exit") + c.gray(" to quit"),
    ""
  ];
  console.log(lines.join("\n"));
}

export function printHelp() {
  console.log(
    [
      "",
      c.bold("Commands"),
      `  ${c.cyan("clone <url>")}    ${c.gray("clone the given website into ./website-clone/")}`,
      `  ${c.cyan("/help")}          ${c.gray("show this help")}`,
      `  ${c.cyan("/files")}         ${c.gray("list output files in ./website-clone/")}`,
      `  ${c.cyan("/open")}          ${c.gray("open ./website-clone/index.html in your browser")}`,
      `  ${c.cyan("/clear")}         ${c.gray("clear the screen")}`,
      `  ${c.cyan("/exit")}          ${c.gray("quit (also: exit, quit, q)")}`,
      "",
      c.bold("Free chat"),
      `  ${c.gray("Anything else is sent to the agent as a normal instruction.")}`,
      ""
    ].join("\n")
  );
}

export function printPrompt() {
  // The actual prompt is rendered by readline.question; this just reserves a label color
  return c.bold(c.cyan("you ")) + c.dim("›") + " ";
}

export function printAssistant(text) {
  if (!text) return;
  console.log("\n" + c.bold(c.magenta("agent ")) + c.dim("›") + " " + text + "\n");
}

export function printError(text) {
  console.log("\n" + c.bold(c.red("error ")) + c.dim("›") + " " + text + "\n");
}

export function printRound(n, label = "thinking") {
  console.log(c.gray(`  ↳ round ${n} `) + c.dim(`· ${label}`));
}

export function printDone(filesInfo = []) {
  console.log("");
  console.log(c.green("  ✓ ") + c.bold("Clone complete"));
  for (const f of filesInfo) {
    console.log(c.gray("    · ") + c.cyan(f.path) + c.gray(` (${f.size} bytes)`));
  }
  console.log(
    c.gray("    Open ") +
      c.bold("./website-clone/index.html") +
      c.gray(" in your browser, or type ") +
      c.bold("/open") +
      "."
  );
  console.log("");
}

/** Render a tool call line with a compact, readable summary instead of dumping raw args. */
export function printToolCall(name, args) {
  const detail = formatToolArgs(name, args);
  const tag = c.yellow("⚙ ") + c.bold(name);
  console.log("    " + tag + (detail ? c.gray(" · ") + detail : ""));
}

function clip(s, n = 60) {
  const v = String(s ?? "");
  return v.length > n ? v.slice(0, n - 1) + "…" : v;
}

function formatToolArgs(name, args = {}) {
  switch (name) {
    case "fetch_to_file":
      return c.gray(args.url || "?") + c.dim(" → ") + c.cyan(args.filePath || "?");
    case "web_fetch":
      return c.gray(args.url || "?");
    case "extract_clone_blueprint":
      return c.cyan(args.sourceFilePath || "?");
    case "write_file": {
      const size = args.content ? `${Buffer.byteLength(String(args.content), "utf8")} bytes` : "";
      return c.cyan(args.filePath || "?") + (size ? c.gray(`  (${size})`) : "");
    }
    case "read_file":
      return c.cyan(args.filePath || "?");
    case "read_file_segment":
      return (
        c.cyan(args.filePath || "?") +
        c.gray(`  @${args.offset ?? 0}+${args.length ?? "?"}`)
      );
    case "rg":
      return (
        c.gray("pattern ") +
        c.cyan(`/${clip(args.pattern, 40)}/`) +
        (args.path ? c.gray(" in ") + c.cyan(args.path) : "")
      );
    case "glob":
      return c.cyan(args.pattern || "?");
    case "shell":
      return c.cyan(clip(args.command, 70));
    case "browser_navigate":
      return c.gray(args.url || "?");
    case "browser_click":
      return c.cyan(args.selector || "?");
    case "browser_scroll":
      return c.gray(`${args.distance ?? 0}px`);
    default:
      return c.gray(clip(JSON.stringify(args), 60));
  }
}

/** Lightweight spinner. Use start() to get a stop() function. */
export function spinner(label = "") {
  if (!ENABLE) {
    return () => {};
  }
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  let active = true;
  process.stdout.write("\x1b[?25l"); // hide cursor
  const render = () => {
    if (!active) return;
    const frame = c.cyan(frames[i = (i + 1) % frames.length]);
    process.stdout.write(`\r    ${frame} ${c.dim(label)}\x1b[K`);
  };
  const id = setInterval(render, 80);
  render();
  return () => {
    if (!active) return;
    active = false;
    clearInterval(id);
    process.stdout.write("\r\x1b[K"); // clear line
    process.stdout.write("\x1b[?25h"); // restore cursor
  };
}

/** Slash-command parsing. Returns null for normal user input. */
export function parseSlashCommand(input) {
  const trimmed = String(input || "").trim();
  if (!trimmed) return { kind: "noop" };
  const lower = trimmed.toLowerCase();
  if (["exit", "quit", "q", "/exit", "/quit", "/q"].includes(lower)) return { kind: "exit" };
  if (lower === "/help" || lower === "/?") return { kind: "help" };
  if (lower === "/clear" || lower === "/cls") return { kind: "clear" };
  if (lower === "/files") return { kind: "files" };
  if (lower === "/open") return { kind: "open" };
  return null;
}

export function clearScreen() {
  process.stdout.write("\x1b[2J\x1b[H");
}
