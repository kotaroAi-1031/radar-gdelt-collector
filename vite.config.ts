import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";

// The Worker itself (name, entrypoint, cron trigger) is defined in
// cloudflare.config.ts; this file only wires the Cloudflare plugin
// into Vite so `cf build` / `cf deploy` can bundle the Worker.
export default defineConfig({
  plugins: [cloudflare()],
});
