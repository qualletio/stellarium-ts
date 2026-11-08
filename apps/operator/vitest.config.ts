import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Each suite starts in-memory PGlite and applies every migration, which takes more than vitest's default
        // 10 seconds on a loaded CI runner, where stellarium-ts's PGlite suites run at the same time.
        testTimeout: 30_000,
        hookTimeout: 30_000,
    },
});
