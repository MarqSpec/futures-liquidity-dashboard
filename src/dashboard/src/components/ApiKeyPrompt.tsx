import type { FormEvent } from "react";

/** Why the prompt is showing. */
export type ApiKeyPromptReason = "missing" | "rejected";

/** Props of the API key prompt. */
export interface ApiKeyPromptProps {
  readonly reason: ApiKeyPromptReason;
  readonly onSubmit: (key: string) => void;
  readonly onClear: () => void;
}

/**
 * Asks for the viewer key. The value is a password field so it is masked, and it is not kept in the DOM after
 * submit. Nothing here places, changes or cancels an order.
 */
export function ApiKeyPrompt({ reason, onSubmit, onClear }: ApiKeyPromptProps) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const key = String(new FormData(form).get("apiKey") ?? "").trim();
    form.reset();
    if (key.length > 0) {
      onSubmit(key);
    }
  };

  return (
    <main className="key-gate">
      <form onSubmit={submit} aria-labelledby="api-key-title">
        <h1 id="api-key-title">API key</h1>
        <p id="api-key-help">
          This dashboard is read-only. Enter the key for this API. It stays in this tab until you close the tab or
          clear it, and it is not built into the page.
        </p>
        {reason === "rejected" && (
          <p role="alert" className="field-help field-help-error">That key was not accepted. Enter it again, or clear it and try another.</p>
        )}
        <label htmlFor="api-key">API key</label>
        <input
          id="api-key"
          name="apiKey"
          type="password"
          autoComplete="off"
          required
          spellCheck={false}
          aria-describedby="api-key-help"
          aria-invalid={reason === "rejected" ? true : undefined}
        />
        <div className="key-actions">
          <button type="submit">Continue</button>
          <button type="button" onClick={onClear}>
            Clear saved key
          </button>
        </div>
      </form>
    </main>
  );
}
