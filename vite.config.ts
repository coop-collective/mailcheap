import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";
import { fileURLToPath } from "node:url";
import { loadRuntimeConfig } from "./scripts/project-config.mjs";

export default defineConfig(({ command }) => ({
  plugins: [
    vinext(),
    cloudflare({
      configPath: loadRuntimeConfig(fileURLToPath(new URL(".", import.meta.url)), { local: command === "serve" }).configPath,
      persistState: { path: fileURLToPath(new URL(".wrangler/state", import.meta.url)) },
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),
  ],
}));
