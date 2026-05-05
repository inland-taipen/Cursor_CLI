#!/usr/bin/env node

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
const MODEL = 'llama3-70b-8192'; // or 'mixtral-8x7b-32768'

// ------------------------------
// Tool Implementations
// ------------------------------
async function fetchWebpage(url) {
  try {
    const response = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 15000,
    });
    return response.data;
  } catch (err) {
    return `Error fetching ${url}: ${err.message}`;
  }
}

function extractDesignTokens(html) {
  const $ = cheerio.load(html);
  
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
      description: 'Extract colors, fonts, nav items, headings, buttons, footer text from HTML',
      parameters: {
        type: 'object',
        properties: { html: { type: 'string', description: 'HTML source' } },
        required: ['html'],
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
const SYSTEM_PROMPT = `You are ScalerCloneAgent, a CLI AI that clones the Scaler Academy website.

Workflow:
1. First call fetchWebpage('https://www.scaler.com/')
2. Then call extractDesignTokens with the fetched HTML.
3. Based on the tokens, create three files using writeFile:
   - index.html (header, hero, footer, at least 5 links)
   - styles.css (responsive, color variables from tokens)
   - scripts.js (hamburger toggle, smooth scroll, header shadow)
4. After writing all files, call openInBrowser('index.html').

Design rules:
- Use exact brand colors from extracted tokens (dark blue/purple gradients).
- Use real Scaler content: "Scaler" logo, nav items like "Explore Programs", "Login", "For Enterprise".
- Hero section should have a bold headline and a CTA button.
- Fonts should come from fontUrls (add Google Fonts link in HTML head).
- All text must come from extracted tokens, no placeholder "Link 1" etc.
- Write one file per response to avoid output length issues.

You must work iteratively – do not generate all files in a single turn. Use the tools in sequence.`;

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

runAgent().catch(console.error);