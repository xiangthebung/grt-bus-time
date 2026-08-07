import { defineConfig, loadEnv } from "vite";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const buildEnv = loadEnv("production", projectRoot, "");
const extensionPayId =
  process.env.EXTPAY_EXTENSION_ID?.trim() || buildEnv.EXTPAY_EXTENSION_ID?.trim() || "grt-next-bus";
const freePaymentModule = fileURLToPath(new URL("./src/payments.free.ts", import.meta.url));

/**
 * The free channel is selected with `vite build --mode free`.
 *
 * It used to be a `BUILD_CHANNEL=free` prefix on the npm script, which is shell
 * syntax that cmd.exe and PowerShell do not understand — `npm run build:free`
 * failed before Vite even started on Windows. `--mode` is a Vite flag, so it
 * behaves the same everywhere. The environment variable is still honoured so any
 * existing CI invocation keeps working.
 */
export default defineConfig(({ mode }) => {
const isFreeBuild =
  mode === "free" ||
  process.env.BUILD_CHANNEL === "free" ||
  buildEnv.BUILD_CHANNEL === "free";
const isProBuild = !isFreeBuild;
const outputDirectory = `${projectRoot}/${isFreeBuild ? "dist-free" : "dist"}`;

return {
  root: `${projectRoot}/src`,
  publicDir: `${projectRoot}/public`,
  base: "./",
  resolve: {
    alias: isProBuild
      ? []
      : [{ find: /^\.\/payments$/, replacement: freePaymentModule }],
  },
  define: {
    __PRO_BUILD__: JSON.stringify(isProBuild),
    __EXTPAY_EXTENSION_ID__: JSON.stringify(extensionPayId),
  },
  plugins: [
    {
      name: "manifest-variant",
      writeBundle() {
        const manifestPath = `${outputDirectory}/manifest.json`;
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
          name: string;
          description: string;
          permissions?: string[];
          optional_permissions?: string[];
          action?: { default_title?: string };
          host_permissions?: string[];
          content_security_policy?: { extension_pages?: string };
        };
        if (isProBuild) {
          manifest.name = "GRT Next Bus";
          manifest.description =
            "Live Grand River Transit departures for your saved stops, with optional Pro countdowns, alerts, and closest-stop ordering.";
          // `offscreen` is how the service worker reaches navigator.geolocation
          // for the closest-stop badge; only the Pro build has a badge.
          manifest.permissions = ["storage", "alarms", "offscreen", "geolocation"];
          manifest.optional_permissions = ["notifications"];
          manifest.host_permissions = [
            "https://webapps.regionofwaterloo.ca/*",
            "https://extensionpay.com/*",
          ];
          manifest.content_security_policy = {
            extension_pages:
              "script-src 'self'; object-src 'self'; connect-src 'self' https://extensionpay.com https://webapps.regionofwaterloo.ca",
          };
          if (manifest.action) manifest.action.default_title = "GRT Next Bus";
        } else {
          manifest.name = "GRT Next Bus Free";
          manifest.description =
            "Live Grand River Transit departures for your saved stops, with nearby stop search and service alerts.";
          manifest.permissions = ["storage", "alarms", "geolocation"];
          delete manifest.optional_permissions;
          manifest.host_permissions = ["https://webapps.regionofwaterloo.ca/*"];
          manifest.content_security_policy = {
            extension_pages:
              "script-src 'self'; object-src 'self'; connect-src 'self' https://webapps.regionofwaterloo.ca",
          };
          if (manifest.action) manifest.action.default_title = "GRT Next Bus Free";
        }
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      },
    },
  ],
  build: {
    outDir: outputDirectory,
    emptyOutDir: true,
    // Chrome extension pages report Vite's modulepreload links as
    // cross-world resource mismatches. The popup is small and its normal
    // module imports are reliable without those hints, so omit them.
    modulePreload: false,
    target: "es2022",
    minify: "esbuild",
    rollupOptions: {
      input: {
        popup: `${projectRoot}/src/popup.html`,
        // Only the Pro build shows a badge, so only it needs the location helper.
        ...(isProBuild ? { offscreen: `${projectRoot}/src/offscreen.html` } : {}),
        background: `${projectRoot}/src/background.ts`,
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
};
});
