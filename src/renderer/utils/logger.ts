/**
 * Renderer-side logger that mirrors console but can be extended
 * to forward logs via IPC to the main process log file.
 */
const isDev = import.meta.env?.DEV ?? true;

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function log(level: LogLevel, ...args: unknown[]): void {
  const timestamp = new Date().toISOString().substring(11, 23);
  const prefix = `[${timestamp}]`;

  switch (level) {
    case 'debug':
      if (isDev) console.debug(prefix, ...args);
      break;
    case 'info':
      console.info(prefix, ...args);
      break;
    case 'warn':
      console.warn(prefix, ...args);
      break;
    case 'error':
      console.error(prefix, ...args);
      break;
  }
}

const rlog = {
  debug: (...args: unknown[]) => log('debug', ...args),
  info: (...args: unknown[]) => log('info', ...args),
  warn: (...args: unknown[]) => log('warn', ...args),
  error: (...args: unknown[]) => log('error', ...args),
};

export default rlog;
