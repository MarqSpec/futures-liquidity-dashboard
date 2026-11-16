import type { CapacitorConfig } from "@capacitor/cli";

// The WebView origin is https://localhost. The API sends no CORS headers, so REST uses the native HTTP stack
// (CapacitorHttp) and the hub uses a direct WebSocket (src/lib/signalr.ts). Release builds deny cleartext
// and mixed content. A debug build's network security config permits cleartext, and MainActivity allows
// mixed content only when the package is debuggable, so an opted-in http LAN server can open ws://. The page still
// refuses HTTP until that opt-in (src/lib/serverUrl.ts). DEPLOYMENT.md, ARCHITECTURE.md D-31.
const config: CapacitorConfig = {
  appId: "com.marqspec.futuresliquidity",
  appName: "Futures Liquidity",
  webDir: "dist",
  android: {
    allowMixedContent: false,
  },
  server: {
    androidScheme: "https",
    cleartext: false,
  },
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
  },
};

export default config;
