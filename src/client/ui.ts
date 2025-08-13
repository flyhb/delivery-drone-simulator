// client/ui.ts
import readline from 'node:readline';

/**
 * Simple readline-based prompt (fallback when no TTY or enquirer unavailable).
 */
export function createAsk() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ask = (q: string) =>
    new Promise<string>((resolve) => rl.question(q, (a) => resolve(a.trim())));
  const close = () => rl.close();
  return { ask, close };
}

/**
 * Compact an address for display, e.g. 0x1234…abcd
 */
export function shortAddr(addr: string, left = 6, right = 4) {
  if (!addr?.startsWith('0x') || addr.length <= left + right + 2) return addr;
  return `${addr.slice(0, 2 + left)}…${addr.slice(-right)}`;
}

/**
 * Arrow-key selection via enquirer with automatic numeric fallback.
 * Pass items with a user-friendly label and a value payload.
 */
export async function selectWithArrows<T>(
  message: string,
  items: Array<{ label: string; value: T }>
): Promise<T> {
  // If nothing to pick, throw early
  if (!items?.length) throw new Error('No items to select from.');

  // Try the rich TTY menu first
  try {
    if (!process.stdout.isTTY) throw new Error('Not a TTY');
    // Lazy import enquirer to avoid hard dep when running headless/CI
    const mod: any = await import('enquirer'); // works with TS + esModuleInterop
    const Select = mod.Select || mod.default?.Select;
    if (!Select) throw new Error('Enquirer Select not found');

    const prompt = new Select({
      name: 'choice',
      message,
      choices: items.map((it, idx) => ({
        name: String(idx + 1),
        message: it.label,
        value: idx,
      })),
    });

    const idx: number = await prompt.run();
    return items[idx].value;
  } catch {
    // Fallback: print a numbered list and ask for a number
    const { ask, close } = createAsk();
    try {
      console.log(`\n${message}`);
      items.forEach((it, i) => console.log(`${i + 1}) ${it.label}`));

      let picked = -1;
      while (picked < 0 || picked >= items.length) {
        const raw = await ask('Enter number: ');
        const n = Number.parseInt(raw, 10);
        if (!Number.isNaN(n) && n >= 1 && n <= items.length) {
          picked = n - 1;
        } else {
          console.log('Invalid selection. Try again.');
        }
      }
      return items[picked].value;
    } finally {
      close();
    }
  }
}