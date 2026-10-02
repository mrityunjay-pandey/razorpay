export type LogLevel = "debug" | "info" | "warn" | "error";
export type Logger = (level: LogLevel, event: string, fields?: Record<string, unknown>) => void;

/** Structured JSON lines on stderr; stdout is reserved for MCP protocol messages. */
export const stderrLogger: Logger = (level, event, fields = {}) => {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }));
};

export const silentLogger: Logger = () => {};
