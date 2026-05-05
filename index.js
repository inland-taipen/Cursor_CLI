import { runAgent } from "./agent.js";

// Browser starts lazily on first browser_* tool (see tools/browser.js)
runAgent().catch(console.error);
