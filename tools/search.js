import fg from 'fast-glob';
import { execa } from 'execa';

export async function glob(pattern, cwd = process.cwd()) {
  const files = await fg(pattern, {
    cwd,
    absolute: true,
    ignore: ['**/node_modules/**', '**/.git/**']
  });
  return files.length ? files.join('\n') : '(no matches)';
}

export async function rg(pattern, path = '.') {
  try {
    const { stdout } = await execa('rg', ['--line-number', pattern, path]);
    return stdout;
  } catch (err) {
    return `No matches or error: ${err.message}`;
  }
}