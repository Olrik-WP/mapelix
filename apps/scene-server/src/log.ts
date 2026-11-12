export type LogLevel = "info" | "warn" | "error";

/** One JSON object per line, so journald and log tools can filter by field. */
export function log(level: LogLevel, event: string, detail: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ time: new Date().toISOString(), level, event, ...detail });
  if (level === "info") process.stdout.write(`${line}\n`);
  else process.stderr.write(`${line}\n`);
}
