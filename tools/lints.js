import { shell } from './shell.js';

export async function readLints() {
  const result = await shell('npx eslint . --format json');
  try {
    const lints = JSON.parse(result);
    return JSON.stringify(lints, null, 2);
  } catch {
    return result; // fallback
  }
}