import { describe, expect, it } from "vitest";
import { FreshdeskClient } from "../src/freshdesk/client.js";
import { ContactService, type ContactSearchParams } from "../src/freshdesk/contacts.js";
import { rawContact, UNEXPOSED_CONTACT_FIELDS } from "./fixtures.js";
import { jsonResponse, mockFetch, requestedUrl, testConfig } from "./helpers.js";

function serviceWith(...responses: Response[]) {
  const fetchMock = mockFetch(...responses);
  return { fetchMock, contacts: new ContactService(new FreshdeskClient(testConfig, { fetch: fetchMock })) };
}

describe("ContactService.get", () => {
  it("requests the contact and returns a compact view", async () => {
    const { fetchMock, contacts } = serviceWith(jsonResponse({ ...rawContact(), ...UNEXPOSED_CONTACT_FIELDS }));

    const contact = await contacts.get(5001);

    expect(requestedUrl(fetchMock)).toBe("https://acme-test.freshdesk.com/api/v2/contacts/5001");
    expect(contact).toEqual({
      id: 5001,
      name: "Asha Example",
      email: "asha@example.test",
      phone: "+91 00000 00001",
      mobile: null,
      companyId: 301,
      jobTitle: "Store Owner",
      language: "en",
      timeZone: "Chennai",
      verified: true,
      tags: ["merchant"],
      createdAt: "2026-01-10T09:00:00Z",
      updatedAt: "2026-09-01T12:00:00Z",
    });
  });

  it("does not forward address, internal notes, custom fields, avatar, devices or other emails", async () => {
    const { contacts } = serviceWith(jsonResponse({ ...rawContact(), ...UNEXPOSED_CONTACT_FIELDS }));
    const serialized = JSON.stringify(await contacts.get(5001));
    for (const leaked of ["Example Street", "do not share", "cf_", "avatar_url", "device_make", "asha.alt@", "twitter"]) {
      expect(serialized).not.toContain(leaked);
    }
  });

  it.each([0, -7, 3.2, Number.NaN])("rejects invalid contact ID %s without calling Freshdesk", async (id) => {
    const { fetchMock, contacts } = serviceWith();
    await expect(contacts.get(id)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a clear message when the contact does not exist", async () => {
    const { contacts } = serviceWith(jsonResponse({}, { status: 404 }));
    await expect(contacts.get(999)).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "The Freshdesk contact with ID 999 was not found.",
    });
  });

  it("rejects a malformed upstream payload", async () => {
    const { contacts } = serviceWith(jsonResponse([rawContact()]));
    await expect(contacts.get(5001)).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });
});

describe("ContactService.search by name", () => {
  it("uses the documented autocomplete endpoint and returns id + name", async () => {
    const { fetchMock, contacts } = serviceWith(
      jsonResponse([
        { id: 33, name: "John Jonz" },
        { id: 456, name: "John Steven Jonz" },
      ]),
    );
    const result = await contacts.search({ name: "  Jo hn " });

    expect(requestedUrl(fetchMock)).toBe("https://acme-test.freshdesk.com/api/v2/contacts/autocomplete?term=Jo%20hn");
    expect(result).toEqual({
      matchedBy: "name",
      contacts: [
        { id: 33, name: "John Jonz" },
        { id: 456, name: "John Steven Jonz" },
      ],
      pagination: { page: 1, perPage: 30, hasMore: false },
    });
  });

  it("caps the number of matches returned to the agent", async () => {
    const many = Array.from({ length: 45 }, (_, i) => ({ id: i + 1, name: `Asha ${i}` }));
    const { contacts } = serviceWith(jsonResponse(many));
    const result = await contacts.search({ name: "Asha" });
    expect(result.contacts).toHaveLength(30);
    expect(result.pagination.hasMore).toBe(true);
  });

  it("ignores malformed entries in the autocomplete response", async () => {
    const { contacts } = serviceWith(jsonResponse([{ id: 1, name: "Ok" }, null, { name: "no id" }]));
    expect((await contacts.search({ name: "Ok" })).contacts).toEqual([{ id: 1, name: "Ok" }]);
  });

  it("treats explicitly-undefined field filters as absent", async () => {
    const { contacts } = serviceWith(jsonResponse([]));
    await expect(contacts.search({ name: "Asha", email: undefined } as ContactSearchParams)).resolves.toMatchObject({
      matchedBy: "name",
    });
  });
});

describe("ContactService.search by fields", () => {
  it("uses List All Contacts with exact-match filters and pagination", async () => {
    const { fetchMock, contacts } = serviceWith(
      jsonResponse([rawContact()], { headers: { Link: '<https://acme-test.freshdesk.com/api/v2/contacts?page=2>; rel="next"' } }),
    );
    const result = await contacts.search({ email: "bat+man@example.test", companyId: 301 });

    expect(requestedUrl(fetchMock)).toBe(
      "https://acme-test.freshdesk.com/api/v2/contacts?email=bat%2Bman%40example.test&company_id=301&page=1&per_page=10",
    );
    expect(result).toEqual({
      matchedBy: "fields",
      contacts: [{ id: 5001, name: "Asha Example", email: "asha@example.test", companyId: 301, verified: true }],
      pagination: { page: 1, perPage: 10, hasMore: true },
    });
  });

  it("omits phone numbers from search results", async () => {
    const { contacts } = serviceWith(jsonResponse([rawContact()]));
    const serialized = JSON.stringify(await contacts.search({ phone: "+91 00000 00001" }));
    expect(serialized).not.toContain("00000");
  });

  it.each<[ContactSearchParams, RegExp]>([
    [{}, /needs a name, or at least one of/],
    [{ name: "A" }, /name must be 2-100 printable characters/],
    [{ name: "   " }, /name must be/],
    [{ name: "x".repeat(101) }, /name must be/],
    [{ name: "Asha\u0000" }, /name must be/],
    [{ name: "Asha", email: "asha@example.test" } as ContactSearchParams, /by name OR by email/],
    [{ email: "nope" }, /email must be a valid email/],
    [{ phone: "call me" }, /phone must be 4-20 characters/],
    [{ mobile: "12" }, /mobile must be/],
    [{ companyId: 0 }, /company_id must be a positive integer/],
    [{ email: "a@example.test", page: 0 }, /page must be an integer between 1 and 100/],
    [{ email: "a@example.test", perPage: 500 }, /per_page must be an integer between 1 and 100/],
  ])("rejects %j before calling Freshdesk", async (params, message) => {
    const { fetchMock, contacts } = serviceWith();
    await expect(contacts.search(params)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringMatching(message),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a non-array upstream payload", async () => {
    const { contacts } = serviceWith(jsonResponse({ results: [] }));
    await expect(contacts.search({ email: "a@example.test" })).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });
});
