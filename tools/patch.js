import { applyPatch as diffApplyPatch } from 'diff';
import fs from 'fs/promises';

export async function applyPatch(filePath, patchText) {
  try {
    const oldContent = await fs.readFile(filePath, 'utf-8');
    const result = diffApplyPatch(oldContent, patchText);
    if (result !== false) {
      await fs.writeFile(filePath, result, 'utf-8');
      return `Patch applied successfully to ${filePath}`;
    }
    return `Failed to apply patch to ${filePath}. The patch may be malformed.`;
  } catch (err) {
    return `Error applying patch: ${err.message}`;
  }
}