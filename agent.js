#!/usr/bin/env node
import 'dotenv/config';
import { createInterface } from 'readline';
import Groq from 'groq-sdk';
import axios from 'axios';
import * as cheerio from 'cheerio';
import fs from 'fs-extra';
import chalk from 'chalk';
import ora from 'ora';

// ------------------------------
// Configuration
// ------------------------------
const OUTPUT_DIR = './scaler-clone';
await fs.ensureDir(OUTPUT_DIR);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const MODEL = 'llama-3.3-70b-versatile'; // or 'mixtral-8x7b-32768'

// ------------------------------
// Tool Implementations
// ------------------------------
import puppeteer from 'puppeteer';

let _cachedHtml = '';

async function fetchWebpage(url) {
  let browser;
  try {
    browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    const html = await page.content();
    await browser.close();
    _cachedHtml = html;
    return `Successfully fetched HTML from ${url} (${html.length} bytes) and cached it internally. Next, call extractDesignTokens() (no arguments needed).`;
  } catch (err) {
    if (browser) await browser.close();
    return `Error fetching ${url}: ${err.message}`;
  }
}

function extractDesignTokens() {
  if (!_cachedHtml) return "Error: No HTML cached. Call fetchWebpage first.";
  const $ = cheerio.load(_cachedHtml);
  
  // Colors from inline styles
  const colors = new Set();
  $('[style]').each((_, el) => {
    const style = $(el).attr('style');
    const matches = style?.match(/#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3}|rgba?\([^)]+\)/g);
    if (matches) matches.forEach(c => colors.add(c));
  });
  
  // Font URLs (Google Fonts, etc.)
  const fontUrls = [];
  $('link[href*="font"], link[href*="googleapis"]').each((_, el) => {
    fontUrls.push($(el).attr('href'));
  });
  
  // Navigation items
  const navItems = [];
  $('nav a, header a').each((_, el) => {
    const text = $(el).text().trim();
    if (text && text.length < 30) navItems.push(text);
  });
  
  // Hero heading (first h1)
  let heroHeading = $('h1').first().text().trim();
  if (!heroHeading) heroHeading = 'Learn from Industry Experts';
  
  // Buttons (common CTA texts)
  const buttons = [];
  $('button, a.btn, a.button, .cta, .hero a').each((_, el) => {
    const text = $(el).text().trim();
    if (text && text.length < 40) buttons.push(text);
  });
  
  // Footer text
  let footerText = $('footer').first().text().trim().slice(0, 300);
  if (!footerText) footerText = 'Scaler Academy – Upskill for Tech Careers';
  
  // Brand name / logo text
  const brand = $('.logo, .brand, header h1, [class*="logo"]').first().text().trim() || 'Scaler';
  
  return {
    colors: Array.from(colors).slice(0, 10),
    fontUrls,
    navItems: navItems.slice(0, 6),
    heroHeading,
    buttons: buttons.slice(0, 3),
    footerText,
    brand,
  };
}

async function writeFile(filePath, content) {
  const fullPath = `${OUTPUT_DIR}/${filePath}`;
  await fs.writeFile(fullPath, content, 'utf8');
  return `Wrote ${fullPath} (${content.length} chars)`;
}

async function readFile(filePath) {
  const fullPath = `${OUTPUT_DIR}/${filePath}`;
  if (!await fs.pathExists(fullPath)) return `File ${filePath} does not exist.`;
  return await fs.readFile(fullPath, 'utf8');
}

async function openInBrowser(filePath) {
  const fullPath = `${OUTPUT_DIR}/${filePath}`;
  if (!await fs.pathExists(fullPath)) return `File ${filePath} not found.`;
  const { exec } = await import('child_process');
  const command = process.platform === 'win32' ? 'start' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
  exec(`${command} "${fullPath}"`);
  return `Opened ${fullPath} in browser.`;
}

// Tool definitions for Groq (OpenAI-compatible format)
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'fetchWebpage',
      description: 'Fetch HTML content from a URL',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'The URL to fetch' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'extractDesignTokens',
      description: 'Extract colors, fonts, nav items, headings, buttons, footer text from the cached HTML',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'writeFile',
      description: 'Write content to a file in the output directory',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Relative path like index.html' },
          content: { type: 'string', description: 'File content' },
        },
        required: ['filePath', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'readFile',
      description: 'Read a file from the output directory',
      parameters: {
        type: 'object',
        properties: { filePath: { type: 'string' } },
        required: ['filePath'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'openInBrowser',
      description: 'Open the generated HTML file in default browser',
      parameters: {
        type: 'object',
        properties: { filePath: { type: 'string' } },
        required: ['filePath'],
      },
    },
  },
];

// Map tool names to functions
const TOOL_FUNCTIONS = {
  fetchWebpage,
  extractDesignTokens,
  writeFile,
  readFile,
  openInBrowser,
};

// ------------------------------
// System Prompt
// ------------------------------
const SYSTEM_PROMPT = `You are ScalerCloneAgent, an elite autonomous AI capable of crafting high-fidelity, production-grade website replicas. Your objective is to clone the Scaler Academy website with premium quality, responsive design, and modern aesthetics.

CRITICAL WORKFLOW (Strictly Sequential Multi-Round Workflow):
1. RESEARCH & FETCH: Use fetchWebpage('https://www.scaler.com/') to gather and cache the raw HTML.
2. EXTRACT DESIGN TOKENS: Use extractDesignTokens() to retrieve authentic fonts, colors, navigation items, buttons, footer text, and brand identity from the cache. Ensure you analyze the output meticulously.
3. BUILD CSS (Phase 1): Write 'styles.css' using writeFile. You MUST use CSS variables (:root) for all colors, fonts, and sizing extracted from the tokens. Implement a modern CSS reset, responsive flexbox/grid layouts, aesthetic spacing (rem/em), and smooth micro-animations on hover states. DO NOT use generic placeholder colors; adhere strictly to the authentic Scaler palette.
4. BUILD HTML (Phase 2): Write 'index.html' using writeFile. Your HTML must be highly semantic (e.g., <header>, <nav>, <section>, <main>, <footer>). It must link 'styles.css' and 'scripts.js'. Include a comprehensive header with navigation, a highly-converting hero section with a compelling call-to-action, a feature/curriculum section, and a professional footer. Inject Google Fonts dynamically via <link> tags based on extracted tokens. NO PLACEHOLDER TEXT ALLOWED. Use the exact text provided by the design tokens.
5. BUILD JS (Phase 3): Write 'scripts.js' using writeFile. Add production-grade interactivity such as a sticky header on scroll (adding a shadow or changing background), a mobile hamburger menu toggle, and smooth scrolling for anchor links.
6. QUALITY ASSURANCE (Phase 4): Use readFile to review your generated 'index.html', 'styles.css', and 'scripts.js' to ensure there are no truncated files, missing links, or syntax errors. Ensure that class names match perfectly between HTML, CSS, and JS.
7. VERIFY & LAUNCH (Phase 5): Call openInBrowser('index.html') only when ALL files are strictly verified and successfully written to disk.

DESIGN & QUALITY STANDARDS (High-Quality Floors):
- Premium Aesthetics: The UI must look like a high-end tech education platform. Use modern UI/UX practices: subtle box-shadows, sleek gradients, rounded corners (border-radius), and glassmorphism if appropriate.
- Responsive by Default: The design must look perfect on mobile, tablet, and desktop screens using media queries.
- No Hardcoding of Data: All copy, headings, and styling variables MUST be derived from the extracted tokens. Do not hallucinate content.
- Strict Iteration & Validation: Write ONE complete file per response to avoid output truncation. Wait for the successful tool execution result before proceeding to the next file.
- Robust Code: Ensure semantic HTML5, clean and maintainable CSS without ad-hoc utility classes unless necessary, and modular JS.

Execute your tasks methodically. You must act autonomously to fix any tool errors. If a tool fails, adjust your strategy. Ensure the final output genuinely reflects the expertise of a Staff/Principal Frontend Engineer.`;

// ------------------------------
// Conversational Agent
// ------------------------------
const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

function askQuestion(query) {
  return new Promise((resolve) => rl.question(query, resolve));
}

async function runAgent() {
  console.log(chalk.blue.bold('\n🤖 ScalerCloneAgent - Chat to clone Scaler Academy'));
  console.log(chalk.gray('Type your instruction (e.g., "clone scaler", or just "start"). Type "exit" to quit.\n'));
  
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: 'Clone the Scaler Academy website for me. Please follow the workflow exactly.' },
  ];
  
  while (true) {
    // Get user input
    const userInput = await askQuestion(chalk.green('You: '));
    if (userInput.toLowerCase() === 'exit') break;
    if (userInput.trim()) {
      messages.push({ role: 'user', content: userInput });
    }
    
    // Agent loop
    while (true) {
      const spinner = ora('Agent thinking...').start();
      let response;
      try {
        response = await groq.chat.completions.create({
          model: MODEL,
          messages,
          tools: TOOLS,
          tool_choice: 'auto',
          temperature: 0.3,
          max_tokens: 8000,
        });
      } catch (err) {
        spinner.fail(`Groq API error: ${err.message}`);
        break;
      }
      spinner.stop();
      
      const assistantMsg = response.choices[0].message;
      messages.push(assistantMsg);
      console.log(chalk.cyan(`\nAgent: ${assistantMsg.content || '[Using tool]'}\n`));
      
      if (assistantMsg.tool_calls) {
        for (const toolCall of assistantMsg.tool_calls) {
          const funcName = toolCall.function.name;
          const args = JSON.parse(toolCall.function.arguments);
          console.log(chalk.yellow(`🔧 Calling tool: ${funcName} with args: ${JSON.stringify(args).slice(0, 120)}`));
          
          const toolFunc = TOOL_FUNCTIONS[funcName];
          if (toolFunc) {
            let result;
            try {
              result = await toolFunc(...Object.values(args));
            } catch (err) {
              result = `Error executing ${funcName}: ${err.message}`;
            }
            const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: resultStr,
            });
            console.log(chalk.gray(`📦 Result: ${resultStr.substring(0, 200)}${resultStr.length > 200 ? '...' : ''}`));
          } else {
            console.log(chalk.red(`Unknown tool: ${funcName}`));
          }
        }
        // After tool calls, continue loop to let agent respond
        continue;
      }
      // No more tool calls — wait for next user instruction
      break;
    }
  }
  rl.close();
  console.log(chalk.gray('\nGoodbye!'));
}

export { runAgent };