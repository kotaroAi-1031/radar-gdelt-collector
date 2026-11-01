import { defineConfig, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

// Storage is Turso (libSQL), not a Cloudflare binding: the Worker connects
// to one database per watch question using the single TURSO_DATABASES_JSON
// secret, and the radar reads locally synced copies on the other side.
// See README.md.
export default defineConfig({
  worker: {
    name: "radar-gdelt-collector",
    compatibilityDate: "2026-10-15",
    entrypoint,
    triggers: [triggers.scheduled({ schedule: "* * * * *" })],
  },
});
