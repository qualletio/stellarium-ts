import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Suites run against Postgres too, through PGlite, which takes seconds to start on a loaded machine.
        testTimeout: 30_000,
        hookTimeout: 30_000,
    },
});
