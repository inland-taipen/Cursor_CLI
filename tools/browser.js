import puppeteer from 'puppeteer';

let browser = null;
let page = null;

export async function initBrowser() {
  if (!browser) {
    try {
      const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
      browser = await puppeteer.launch({
        headless: process.env.PUPPETEER_HEADLESS === "1" ? true : false,
        ...(executablePath ? { executablePath } : {})
      });
    } catch (err) {
      const hint =
        "Chrome for Puppeteer is missing. From the project root run: npx puppeteer browsers install chrome";
      throw new Error(`${hint}\nOriginal error: ${err.message}`);
    }
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
  }
  return { browser, page };
}

export async function browserNavigate(url) {
  try {
    const { page } = await initBrowser();
    await page.goto(url, { waitUntil: 'networkidle2' });
    return `Navigated to ${url}`;
  } catch (err) {
    return `browser_navigate failed: ${err.message}`;
  }
}

export async function browserSnapshot() {
  try {
    const { page } = await initBrowser();
    const snapshot = await page.accessibility.snapshot();
    return JSON.stringify(snapshot, null, 2);
  } catch (err) {
    return `browser_snapshot failed: ${err.message}`;
  }
}

export async function browserTakeScreenshot(path = 'screenshot.png') {
  try {
    const { page } = await initBrowser();
    await page.screenshot({ path, fullPage: true });
    return `Screenshot saved to ${path}`;
  } catch (err) {
    return `browser_take_screenshot failed: ${err.message}`;
  }
}

export async function browserClick(selector) {
  try {
    const { page } = await initBrowser();
    await page.click(selector);
    return `Clicked element: ${selector}`;
  } catch (err) {
    return `browser_click failed (${selector}): ${err.message}`;
  }
}

export async function browserScroll(distance) {
  try {
    const { page } = await initBrowser();
    await page.evaluate((dist) => window.scrollBy(0, dist), distance);
    return `Scrolled by ${distance}px`;
  } catch (err) {
    return `browser_scroll failed: ${err.message}`;
  }
}