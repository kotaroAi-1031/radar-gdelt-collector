import { defineConfig, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

// Storage is Turso (libSQL), not a Cloudflare binding: the Worker connects
// with TURSO_DATABASE_URL / TURSO_AUTH_TOKEN secrets, and the radar reads a
// locally synced replica on the other side. See README.md.
export default defineConfig({
  worker: {
    name: "radar-gdelt-collector",
    compatibilityDate: "2026-10-15",
    entrypoint,
    triggers: [triggers.scheduled({ schedule: "* * * * *" })],
  },
});
