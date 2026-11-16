import { describe, expect, it } from "vitest";

import { redactSecrets } from "./redactSecrets.ts";

describe("redactSecrets", () => {
  const key = "synthetic-test-key-es-viewer";

  it("should remove an access token from a hub url when the message contains one", () => {
    const line = `Failed to start http://localhost/hubs/market?id=abc&access_token=${key}`;

    const redacted = redactSecrets(line);

    expect(redacted).not.toContain(key);
    expect(redacted).toContain("access_token=[redacted]");
    expect(redacted).toContain("id=abc");
  });

  it("should remove an API key header and a bearer token when the message contains them", () => {
    expect(redactSecrets(`X-Api-Key: ${key}`)).toBe("X-Api-Key: [redacted]");
    expect(redactSecrets(`X-Api-Key=${key}&next=1`)).toBe("X-Api-Key=[redacted]&next=1");
    expect(redactSecrets(`Authorization: Bearer ${key}`)).toBe("Authorization: Bearer [redacted]");
  });

  it("should leave an ordinary hub error when it has no key", () => {
    const line = "Status code '401'";

    expect(redactSecrets(line)).toBe(line);
  });
});
