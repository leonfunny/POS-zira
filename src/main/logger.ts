import { createLogger, format, transports } from 'winston';
import { app } from 'electron';
import { join } from 'path';

// Get app data directory (works before app is ready too)
const getLogDir = () => {
  try {
    return app.getPath('userData');
  } catch {
    return '.';
  }
};

// Check if we have a valid console attached
// When app runs via Windows auto-start without console, writing to stdout/stderr
// will cause EPIPE errors that can crash the app
const hasConsole = (): boolean => {
  // In development mode, always assume we have console
  if (process.env.NODE_ENV === 'development') {
    return true;
  }

  // Check if stdout is a TTY (terminal)
  // If not, we might not have a proper console
  try {
    return process.stdout?.isTTY === true || process.stderr?.isTTY === true;
  } catch {
    return false;
  }
};

// Create console transport with error handling
const consoleTransport = new transports.Console({
  format: format.combine(
    format.colorize(),
    format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level}] ${message}`;
    })
  ),
  // Disable console in production when no TTY (prevents EPIPE)
  silent: !hasConsole(),
});

// Handle EPIPE errors on console transport to prevent crash
consoleTransport.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') {
    // Silently disable console transport when pipe breaks
    consoleTransport.silent = true;
  }
});

const logger = createLogger({
  level: process.env.NODE_ENV === 'development' ? 'debug' : 'info',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true }),
    format.printf(({ timestamp, level, message, stack }) => {
      return `${timestamp} [${level.toUpperCase()}] ${message}${stack ? '\n' + stack : ''}`;
    })
  ),
  // CRITICAL: Handle errors on logger level to prevent EPIPE crashes
  exceptionHandlers: [],
  rejectionHandlers: [],
  transports: [
    consoleTransport,
    // File transport (always enabled - this is the reliable log destination)
    new transports.File({
      filename: join(getLogDir(), 'logs', 'error.log'),
      level: 'error',
      maxsize: 5 * 1024 * 1024, // 5MB
      maxFiles: 3,
    }),
    new transports.File({
      filename: join(getLogDir(), 'logs', 'combined.log'),
      maxsize: 5 * 1024 * 1024, // 5MB
      maxFiles: 5,
    }),
  ],
});

// Global error handler on logger to prevent unhandled EPIPE
logger.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') {
    // Disable console transport if EPIPE occurs
    consoleTransport.silent = true;
  }
});

export default logger;
