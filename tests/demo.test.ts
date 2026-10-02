import { describe, expect, it } from "vitest";
import { runDemo } from "../demo/run-demo.js";

/** Keeps the submission demo from silently breaking. Mock mode only; sleeps are skipped. */
describe("mock demo", () => {
  it("runs every step end to end and is clearly labelled as a simulation", async () => {
    let output = "";
    await runDemo({ mode: "mock", write: (t) => (output += t), retry: { sleep: async () => {} } });

    expect(output).toContain("MOCK MODE: simulated Freshdesk");
    expect(output).toContain("This is NOT a run against a real Freshdesk account.");
    for (let n = 1; n <= 8; n++) expect(output).toContain(`STEP ${n} ·`);

    expect(output).toContain('"code":"AUTHENTICATION_ERROR"');
    expect(output).toContain('Freshdesk query built by the connector: "status:2 AND (priority:3 OR priority:4)"');
    expect(output).toContain("pagination.hasMore = true");
    expect(output).toContain('"name": "Asha Example"');
    expect(output).toContain('"delayMs":1000,"code":"RATE_LIMITED"');
    expect(output).toContain("recovered after retry: isError=false");
    expect(output).toContain("The connector retried 3 times without success.");
    expect(output).toContain('"code":"NOT_FOUND"');
    expect(output).toContain("Tool delete_ticket not found");

    // Values of fields the connector must drop never appear, even though the mock returns them.
    // (Field *names* do appear, in the demo's own "Dropped: …" explanations.)
    for (const leaked of ["finance-team@", "cf_internal_risk_score", "Example Street", "prefers email", "<div>"]) {
      expect(output).not.toContain(leaked);
    }
    expect(output).not.toContain("demoMockKeyNotReal123");
  });
});
