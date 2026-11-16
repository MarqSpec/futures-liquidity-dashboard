import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ApiKeyPrompt } from "./ApiKeyPrompt.tsx";

describe("ApiKeyPrompt", () => {
  it("should name the key field and mask it when the viewer has not entered one", () => {
    const html = renderToString(<ApiKeyPrompt reason="missing" onSubmit={() => undefined} onClear={() => undefined} />);

    expect(html).toContain('for="api-key"');
    expect(html).toContain('type="password"');
    expect(html).toContain("API key");
    expect(html).toContain("this tab");
    expect(html).not.toContain("synthetic-test-key");
    expect(html).not.toContain('role="alert"');
  });

  it("should say the key was rejected when the server answered 401", () => {
    const html = renderToString(<ApiKeyPrompt reason="rejected" onSubmit={() => undefined} onClear={() => undefined} />);

    expect(html).toContain('role="alert"');
    expect(html).toContain("not accepted");
    expect(html).toContain("Clear saved key");
  });
});
