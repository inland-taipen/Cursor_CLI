import fs from 'fs/promises';
import path from 'path';

const READ_FILE_MAX = 8000;

export async function readFile(filePath) {
  try {
    const abs = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
    const content = await fs.readFile(abs, 'utf-8');
    if (content.length > READ_FILE_MAX) {
      return content.slice(0, READ_FILE_MAX) + `\n...[truncated ${content.length - READ_FILE_MAX} chars; use read_file_segment for the rest]`;
    }
    return content;
  } catch (err) {
    return `Error reading file: ${err.message}`;
  }
}

/** Read a slice of a UTF-8 file by character offset (for huge HTML like _source.html). */
export async function readFileSegment(filePath, offset = 0, length = 4000) {
  try {
    const abs = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
    const full = await fs.readFile(abs, "utf-8");
    const start = Math.max(0, Math.floor(Number(offset) || 0));
    const len = Math.min(6000, Math.max(1, Math.floor(Number(length) || 4000)));
    const slice = full.slice(start, start + len);
    return `[chars ${start}–${start + slice.length} of ${full.length}]\n${slice}`;
  } catch (err) {
    return `Error reading segment: ${err.message}`;
  }
}

export async function writeFile(filePath, content) {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
  const dir = path.dirname(abs);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(abs, content, 'utf-8');
  return `Written to ${abs}`;
}