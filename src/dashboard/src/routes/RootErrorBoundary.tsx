import { isRouteErrorResponse, useRouteError } from "react-router";

// The root error boundary (CONVENTIONS.md §7): a categorised message, never a stack trace.
export function RootErrorBoundary() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error) ? `${error.status} ${error.statusText}` : "Something went wrong.";
  return (
    <main>
      <h1>Sorry</h1>
      <p role="alert">{message}</p>
    </main>
  );
}
