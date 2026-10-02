import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateToolSpec, SPEC_PATH } from "../demo/generate-tool-spec.js";

describe("docs/mcp-tools.json", () => {
  it("matches what the server actually advertises (run `npm run spec` after changing tools)", async () => {
    const committed = readFileSync(SPEC_PATH, "utf8").replace(/\r\n/g, "\n");
    expect(committed).toBe(await generateToolSpec());
  });
});
