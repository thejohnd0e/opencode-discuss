import { fileURLToPath } from "node:url"

/**
 * The bundled dialogue runner, resolved relative to this package rather than
 * the project OpenCode is opened in. Works from both `src/` and `dist/`, which
 * sit next to `scripts/`.
 */
export const DEFAULT_RUNNER = fileURLToPath(new URL("../scripts/discuss-runner.py", import.meta.url))
