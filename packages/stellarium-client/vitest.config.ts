import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // The integration suite starts a real node, which can take seconds on a loaded CI runner.
        testTimeout: 30_000,
        hookTimeout: 30_000,
    },
});
