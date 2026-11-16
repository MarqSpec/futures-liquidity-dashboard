import { useState, type FormEvent } from "react";

/** The first-run and "change server" form. It stores a URL only; the API key stays with the auth prompt. */
export function ServerSettings({
  initialBase,
  initialCleartext,
  onSubmit,
  onCancel,
}: {
  initialBase: string;
  initialCleartext: boolean;
  onSubmit: (base: string, allowCleartext: boolean) => string | null;
  onCancel: (() => void) | null;
}) {
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const base = String(data.get("server") ?? "");
    const allowCleartext = data.get("cleartext") === "on";
    setError(onSubmit(base, allowCleartext));
  }

  return (
    <main className="server-url-screen">
      <form className="server-url-card" onSubmit={submit}>
        <h1>Server</h1>
        <p>The app keeps its screens on the phone and calls this server for market data. Use the origin that serves /api and /hubs/market.</p>
        <label htmlFor="server-url">
          Server URL
          <input
            id="server-url"
            name="server"
            type="url"
            inputMode="url"
            autoComplete="url"
            autoCapitalize="none"
            spellCheck={false}
            required
            placeholder="https://dashboard.example"
            defaultValue={initialBase}
            aria-invalid={error !== null}
            aria-describedby={error !== null ? "server-url-error" : undefined}
          />
        </label>
        <label className="server-url-check" htmlFor="server-cleartext">
          <input id="server-cleartext" name="cleartext" type="checkbox" defaultChecked={initialCleartext} aria-describedby="server-cleartext-risk" />
          Allow cleartext HTTP
        </label>
        <p id="server-cleartext-risk" className="server-url-warning">
          HTTP sends the API key and the market data with no encryption. Use it only for a machine on your own LAN, or for local development.
        </p>
        <p>The API key uses the same prompt as the website. This screen does not store a key.</p>
        {error !== null && (
          <p id="server-url-error" className="server-url-error field-help field-help-error" role="alert">
            {error}
          </p>
        )}
        <div className="server-url-actions">
          <button type="submit">Save and reload</button>
          {onCancel !== null && (
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>
      </form>
    </main>
  );
}
