import fs from "fs/promises";
import path from "node:path";
import fetch from "node-fetch";

const WEB_FETCH_INLINE_MAX = 8000;

const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9"
};

export async function webFetch(url) {
  const res = await fetch(url, { redirect: "follow", headers: FETCH_HEADERS });
  const text = await res.text();
  const note =
    text.length > WEB_FETCH_INLINE_MAX
      ? `\n...[truncated ${text.length - WEB_FETCH_INLINE_MAX} chars; use fetch_to_file for the full response]`
      : "";
  return text.substring(0, WEB_FETCH_INLINE_MAX) + note;
}

/** Saves full response body to disk (best for cloning); keeps chat context small. */
export async function fetchToFile(url, filePath) {
  try {
    const res = await fetch(url, { redirect: "follow", headers: FETCH_HEADERS });
    const buf = Buffer.from(await res.arrayBuffer());
    const abs = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, buf);
    return `fetch_to_file: HTTP ${res.status}, ${buf.length} bytes -> ${abs}`;
  } catch (err) {
    return `fetch_to_file failed: ${err.message}`;
  }
}

function uniq(list, max = 10) {
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const v = String(item || "").replace(/\s+/g, " ").trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  if (h.length === 3) {
    return {
      r: parseInt(h[0] + h[0], 16),
      g: parseInt(h[1] + h[1], 16),
      b: parseInt(h[2] + h[2], 16)
    };
  }
  if (h.length === 6) {
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16)
    };
  }
  return { r: 0, g: 0, b: 0 };
}

function luminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function chroma(hex) {
  const { r, g, b } = hexToRgb(hex);
  return (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
}

/**
 * Pure analyzer: returns ONLY what was found in the source HTML.
 * No site-specific defaults or copy fallbacks — if nothing is found, the field is null/empty.
 */
export async function extractCloneBlueprint(sourceFilePath) {
  try {
    const abs = path.isAbsolute(sourceFilePath)
      ? sourceFilePath
      : path.join(process.cwd(), sourceFilePath);
    const html = await fs.readFile(abs, "utf-8");
    const noScripts = html.replace(/<script[\s\S]*?<\/script>/gi, "");

    const title =
      noScripts.match(/<title[^>]*>([^<]{2,200})<\/title>/i)?.[1]?.trim() ?? null;

    const ogSiteName =
      noScripts.match(/property=["']og:site_name["'][^>]*content=["']([^"']{2,80})["']/i)?.[1]?.trim() ??
      noScripts.match(/name=["']application-name["'][^>]*content=["']([^"']{2,80})["']/i)?.[1]?.trim() ??
      null;

    const metaDescription =
      noScripts.match(/name=["']description["'][^>]*content=["']([^"']{10,300})["']/i)?.[1]?.trim() ?? null;

    const themeColor =
      noScripts.match(/name=["']theme-color["'][^>]*content=["']([^"']{3,20})["']/i)?.[1]?.trim() ??
      noScripts.match(/content=["']([^"']{3,20})["'][^>]*name=["']theme-color["']/i)?.[1]?.trim() ??
      null;

    // Linked stylesheets (<link rel="stylesheet" href="...">)
    const linkedStylesheets = uniq(
      Array.from(html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/gi)).map(m => m[1]).concat(
        Array.from(html.matchAll(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["']stylesheet["']/gi)).map(m => m[1])
      ),
      6
    );

    // Google Fonts / Adobe Fonts / TypeKit URLs
    const fontLinks = uniq(
      [
        ...Array.from(html.matchAll(/href=["'](https:\/\/fonts\.googleapis\.com[^"']+)["']/gi)).map(m => m[1]),
        ...Array.from(html.matchAll(/href=["'](https:\/\/fonts\.gstatic\.com[^"']+)["']/gi)).map(m => m[1]),
        ...Array.from(html.matchAll(/href=["'](https:\/\/use\.typekit\.net[^"']+)["']/gi)).map(m => m[1]),
        ...Array.from(html.matchAll(/@import\s+url\(['"]?(https:\/\/fonts\.googleapis\.com[^'"\)]+)['"]?\)/gi)).map(m => m[1])
      ],
      4
    );

    // Logo image src
    const logoSrc =
      html.match(/<img[^>]*(?:class|id|alt)=["'][^"']*logo[^"']*["'][^>]*src=["']([^"']+)["']/i)?.[1] ??
      html.match(/<img[^>]*src=["']([^"']*logo[^"']*)["']/i)?.[1] ??
      null;

    const navItems = uniq(
      [
        ...Array.from(noScripts.matchAll(/<a\b[^>]*>([^<]{2,40})<\/a>/gi)).map((m) => m[1]),
        ...Array.from(noScripts.matchAll(/>([A-Z][A-Z& ]{3,28})</g)).map((m) => m[1])
      ],
      10
    );

    const headings = uniq(
      Array.from(noScripts.matchAll(/<h[1-3]\b[^>]*>([^<]{4,200})<\/h[1-3]>/gi)).map((m) => m[1]),
      14
    );

    const paragraphs = uniq(
      Array.from(noScripts.matchAll(/<p\b[^>]*>([^<]{20,260})<\/p>/gi)).map((m) => m[1]),
      14
    );

    const buttonTexts = uniq(
      Array.from(noScripts.matchAll(/<button\b[^>]*>([^<]{2,40})<\/button>/gi)).map((m) => m[1]),
      8
    );

    const colorHexes = uniq(
      [
        ...Array.from(noScripts.matchAll(/(?:from|to|bg|text|border)-\[#([0-9a-fA-F]{6})\]/g)).map((m) => `#${m[1]}`),
        ...Array.from(noScripts.matchAll(/#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)).map((m) => m[0])
      ],
      20
    );

    const cssVariables = uniq(
      Array.from(noScripts.matchAll(/--[a-z0-9-]+/gi)).map((m) => m[0]),
      24
    );

    const gradients = uniq(
      Array.from(noScripts.matchAll(/linear-gradient\([^)]{0,180}\)/gi)).map((m) => m[0]),
      10
    );

    // Group hexes by visual role using luminance/chroma — NO hardcoded fallback colors.
    const palette = {};
    for (const c of colorHexes) {
      const L = luminance(c);
      const C = chroma(c);
      if (L < 0.18 && C < 0.2) palette.darkest ??= c;
      else if (L > 0.86 && C < 0.1) palette.lightest ??= c;
      else if (L > 0.7 && L < 0.92 && C < 0.15) palette.light ??= c;
      else if (C > 0.18 && L < 0.78) {
        const { r, g, b } = hexToRgb(c);
        if (r > g && g > b) palette.warmAccent ??= c;
        else if (b > g && g > r) palette.coolAccent ??= c;
        else palette.accent ??= c;
      }
    }

    return JSON.stringify(
      {
        sourceFile: abs,
        title,
        ogSiteName,
        metaDescription,
        themeColor,
        navItems,
        headings,
        paragraphs,
        buttonTexts,
        colorHexes,
        cssVariables,
        gradients,
        palette,
        linkedStylesheets,
        fontLinks,
        logoSrc,
        note:
          "These fields are RAW extractions from the fetched source HTML. Use them to write index.html/styles.css/scripts.js yourself with write_file. No hardcoded site defaults are applied."
      },
      null,
      2
    );
  } catch (err) {
    return `extract_clone_blueprint failed: ${err.message}`;
  }
}

const FETCH_LINKED_CSS_MAX = 8000;

/**
 * Resolves <link rel="stylesheet"> hrefs from a downloaded HTML file,
 * fetches up to 3 of them, and returns their combined CSS (truncated).
 * This gives the model real font-family, spacing, and brand CSS variable data.
 */
export async function fetchLinkedCss(sourceFilePath, baseUrl) {
  try {
    const abs = path.isAbsolute(sourceFilePath)
      ? sourceFilePath
      : path.join(process.cwd(), sourceFilePath);
    const html = await fs.readFile(abs, "utf-8");

    // Collect all stylesheet hrefs
    const hrefs = [];
    for (const re of [
      /<link[^>]+rel=['"]stylesheet['"][^>]*href=['"]([^'"]+)['"]/gi,
      /<link[^>]+href=['"]([^'"]+)['"][^>]*rel=['"]stylesheet['"]/gi
    ]) {
      for (const m of html.matchAll(re)) hrefs.push(m[1]);
    }

    // Resolve hrefs to absolute URLs using baseUrl
    const base = new URL(baseUrl);
    const resolved = [...new Set(hrefs)]
      .map(href => {
        try {
          return new URL(href, base).href;
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      // Prefer same-origin stylesheets; skip font services (already covered by fontLinks)
      .filter(u => !u.includes("fonts.googleapis") && !u.includes("typekit.net"))
      .slice(0, 3);

    if (!resolved.length) {
      return "fetch_linked_css: no linked stylesheets found in source HTML (or all were font service URLs).";
    }

    const parts = [];
    for (const cssUrl of resolved) {
      try {
        const res = await fetch(cssUrl, { redirect: "follow", headers: FETCH_HEADERS });
        const text = await res.text();
        parts.push(`/* === ${cssUrl} (HTTP ${res.status}) === */\n${text}`);
      } catch (err) {
        parts.push(`/* === ${cssUrl} FAILED: ${err.message} === */`);
      }
    }

    const combined = parts.join("\n\n");
    const note = combined.length > FETCH_LINKED_CSS_MAX
      ? `\n...[truncated ${combined.length - FETCH_LINKED_CSS_MAX} chars]`
      : "";
    return combined.slice(0, FETCH_LINKED_CSS_MAX) + note;
  } catch (err) {
    return `fetch_linked_css failed: ${err.message}`;
  }
}
