import { Outlet, useNavigation } from "react-router";

// The layout every route renders inside: shared chrome and a pending indicator around the matched child route.
export function RootLayout() {
  const navigation = useNavigation();
  return (
    <>
      {navigation.state === "loading" && <output>Loading…</output>}
      <Outlet />
    </>
  );
}
