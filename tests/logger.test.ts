import { describe, expect, it, vi } from "vitest";
import { stderrLogger } from "../src/logger.js";

describe("stderrLogger", () => {
  it("writes one structured JSON line to stderr and nothing to stdout", () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});

    stderrLogger("warn", "freshdesk_retry", { path: "/tickets", attempt: 1 });

    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(stderr.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(line).toMatchObject({ level: "warn", event: "freshdesk_retry", path: "/tickets", attempt: 1 });
    expect(typeof line.ts).toBe("string");
  });
});
