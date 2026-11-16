import { useChangeServer } from "../lib/changeServer.ts";

/** Shown in the native shell wherever the dashboard or the key gate can get stuck on the wrong server. */
export function ChangeServerButton() {
  const changeServer = useChangeServer();
  if (!changeServer) {
    return null;
  }
  return (
    <button type="button" onClick={changeServer}>
      Change server
    </button>
  );
}
