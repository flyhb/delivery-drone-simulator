import readline from 'readline';

/**
 * Display a simple interactive menu in the terminal and allow the user to
 * select one of the provided options using the up/down arrow keys.  The
 * function returns the zero‑based index of the chosen option once the
 * user presses Enter.  If the terminal does not support raw mode or
 * arrow keys, this will fall back to a numeric prompt (1‑based) similar
 * to the previous behaviour.
 *
 * @param message Introductory text to show before the list
 * @param options Array of strings representing each choice
 */
export async function promptSelect(message: string, options: string[]): Promise<number> {
  // If stdout is not a TTY or raw mode cannot be enabled, fall back
  // to numeric input using readline.  This branch preserves the
  // previous behaviour of asking the user to type the number of
  // their selection.
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    console.log(message);
    options.forEach((opt, i) => {
      console.log(`[${i + 1}] ${opt}`);
    });
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
      const ask = () => {
        rl.question('Select option number: ', (answer) => {
          const n = Number(answer.trim());
          if (Number.isInteger(n) && n >= 1 && n <= options.length) {
            rl.close();
            resolve(n - 1);
          } else {
            ask();
          }
        });
      };
      ask();
    });
  }

  // Raw mode interactive selection.  We redraw the menu on every
  // keypress and move a pointer up/down with the arrow keys.  The
  // pointer starts at index 0.  The promise resolves when the user
  // presses Enter.
  return new Promise((resolve) => {
    let index = 0;

    const render = () => {
      // Clear the screen before rendering.  Use ANSI escape codes
      // rather than console.clear() for more predictable behaviour.
      process.stdout.write('\u001B[2J\u001B[0;0H');
      console.log(message);
      options.forEach((opt, i) => {
        const pointer = i === index ? '>' : ' ';
        console.log(`${pointer} ${opt}`);
      });
    };

    // Emit keypress events from stdin
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);

    const onKeypress = (str: string, key: readline.Key) => {
      if (key.name === 'up' || key.name === 'k') {
        if (index > 0) index--;
        render();
      } else if (key.name === 'down' || key.name === 'j') {
        if (index < options.length - 1) index++;
        render();
      } else if (key.name === 'return' || key.name === 'enter') {
        cleanup();
        resolve(index);
      } else if (key.name === 'c' && key.ctrl) {
        cleanup();
        process.exit();
      }
    };
    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.off('keypress', onKeypress);
    };
    process.stdin.on('keypress', onKeypress);
    render();
  });
}