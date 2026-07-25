import { defineConfig, loadEnv } from "vite";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const buildEnv = loadEnv("production", projectRoot, "");
const isFreeBuild = process.env.BUILD_CHANNEL === "free" || buildEnv.BUILD_CHANNEL === "free";
const isProBuild = !isFreeBuild;
const extensionPayId =
  process.env.EXTPAY_EXTENSION_ID?.trim() || buildEnv.EXTPAY_EXTENSION_ID?.trim() || "grt-next-bus";
const outputDirectory = `${projectRoot}/${isFreeBuild ? "dist-free" : "dist"}`;
const freePaymentModule = fileURLToPath(new URL("./src/payments.free.ts", import.meta.url));

export default defineConfig({
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
            "See Grand River Transit departures, with optional Pro countdowns, closest-stop ordering, and arrival alerts.";
          manifest.permissions = ["storage", "alarms", "geolocation"];
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
            "See the next three Grand River Transit departures for your saved stops, with nearby stop finding.";
          manifest.permissions = ["storage", "geolocation"];
          delete manifest.optional_permissions;
          manifest.host_permissions = ["https://webapps.regionofwaterloo.ca/*"];
          delete manifest.content_security_policy;
          if (manifest.action) manifest.action.default_title = "GRT Next Bus Free";
        }
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      },
    },
  ],
  build: {
    outDir: outputDirectory,
    emptyOutDir: true,
    target: "es2022",
    minify: "esbuild",
    rollupOptions: {
      input: {
        popup: `${projectRoot}/src/popup.html`,
        background: `${projectRoot}/src/background.ts`,
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
