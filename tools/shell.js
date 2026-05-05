import { execa } from 'execa';

export async function shell(command, cwd = process.cwd()) {
  try {
    const { stdout, stderr } = await execa(command, { shell: true, cwd });
    return stdout || stderr || 'Command executed with no output';
  } catch (err) {
    return `Command failed: ${err.message}\n${err.stderr || ''}`;
  }
}