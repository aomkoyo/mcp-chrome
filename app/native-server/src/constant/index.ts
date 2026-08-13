export enum NATIVE_MESSAGE_TYPE {
  START = 'start',
  STARTED = 'started',
  STOP = 'stop',
  STOPPED = 'stopped',
  PING = 'ping',
  PONG = 'pong',
  ERROR = 'error',
}

export const NATIVE_SERVER_PORT = 12306;

// Timeout constants (in milliseconds)
export const TIMEOUTS = {
  DEFAULT_REQUEST_TIMEOUT: 15000,
  EXTENSION_REQUEST_TIMEOUT: 20000,
  PROCESS_DATA_TIMEOUT: 20000,
} as const;

// Server configuration
export const SERVER_CONFIG = {
  HOST: '0.0.0.0',
  /**
   * Address clients (agents, MCP config) should dial. The listen address is
   * 0.0.0.0 (all interfaces), which is not a valid destination to connect to.
   */
  CLIENT_HOST: '127.0.0.1',
  /**
   * CORS origin whitelist - allows Chrome/Firefox extensions, local debugging,
   * and private-LAN origins (the server listens on 0.0.0.0).
   * Use RegExp patterns for prefix/pattern matching, string for startsWith match.
   */
  CORS_ORIGIN: [
    /^chrome-extension:\/\//,
    /^moz-extension:\/\//,
    'http://127.0.0.1',
    'http://localhost',
    // ponytail: private IPv4 ranges only (RFC1918 + link-local), any port.
    /^https?:\/\/10\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?$/,
    /^https?:\/\/192\.168\.\d{1,3}\.\d{1,3}(:\d+)?$/,
    /^https?:\/\/172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}(:\d+)?$/,
    /^https?:\/\/169\.254\.\d{1,3}\.\d{1,3}(:\d+)?$/,
    // Tailscale CGNAT range 100.64.0.0/10
    /^https?:\/\/100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\.\d{1,3}\.\d{1,3}(:\d+)?$/,
  ] as const,
  LOGGER_ENABLED: false,
} as const;

// HTTP Status codes
export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  INTERNAL_SERVER_ERROR: 500,
  GATEWAY_TIMEOUT: 504,
} as const;

// Error messages
export const ERROR_MESSAGES = {
  NATIVE_HOST_NOT_AVAILABLE: 'Native host connection not established.',
  SERVER_NOT_RUNNING: 'Server is not actively running.',
  REQUEST_TIMEOUT: 'Request to extension timed out.',
  INVALID_MCP_REQUEST: 'Invalid MCP request or session.',
  INVALID_SESSION_ID: 'Invalid or missing MCP session ID.',
  INTERNAL_SERVER_ERROR: 'Internal Server Error',
  MCP_SESSION_DELETION_ERROR: 'Internal server error during MCP session deletion.',
  MCP_REQUEST_PROCESSING_ERROR: 'Internal server error during MCP request processing.',
  INVALID_SSE_SESSION: 'Invalid or missing MCP session ID for SSE.',
} as const;

// ============================================================
// Chrome MCP Server Configuration
// ============================================================

/**
 * Environment variables for dynamically resolving the local MCP HTTP endpoint.
 * CHROME_MCP_PORT is the preferred source; MCP_HTTP_PORT is kept for backward compatibility.
 */
export const CHROME_MCP_PORT_ENV = 'CHROME_MCP_PORT';
export const MCP_HTTP_PORT_ENV = 'MCP_HTTP_PORT';

/**
 * Get the actual port the Chrome MCP server is listening on.
 * Priority: CHROME_MCP_PORT env > MCP_HTTP_PORT env > NATIVE_SERVER_PORT default
 */
export function getChromeMcpPort(): number {
  const raw = process.env[CHROME_MCP_PORT_ENV] || process.env[MCP_HTTP_PORT_ENV];
  const port = raw ? Number.parseInt(String(raw), 10) : NaN;
  return Number.isFinite(port) && port > 0 && port <= 65535 ? port : NATIVE_SERVER_PORT;
}

/**
 * Get the full URL to the local Chrome MCP HTTP endpoint.
 * This URL is used by Claude/Codex agents to connect to the MCP server.
 */
export function getChromeMcpUrl(): string {
  return `http://${SERVER_CONFIG.CLIENT_HOST}:${getChromeMcpPort()}/mcp`;
}
