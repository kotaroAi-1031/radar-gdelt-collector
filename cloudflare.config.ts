import { bindings, defineConfig, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
  worker: {
    name: "radar-gdelt-collector",
    compatibilityDate: "2026-10-15",
    entrypoint,
    env: {
      DB: bindings.d1({
        name: "radar-gdelt",
        id: "1fdef0f9-fa0e-49b1-8087-d8bc9ab22d95",
      }),
    },
    triggers: [triggers.scheduled({ schedule: "*/10 * * * *" })],
  },
});
