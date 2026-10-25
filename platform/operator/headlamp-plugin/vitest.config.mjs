// Headlamp's own Vite/Vitest config (what `headlamp-plugin test` runs), plus:
// - an alias so tests can vi.mock '@kinvolk/headlamp-plugin/lib/k8s/cluster': in the built plugin
//   that import is an external served by Headlamp (pluginLib.K8s), and no file has that path;
// - the coverage gate (`bun run test:coverage`, run in CI).
import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vitest/config';
import headlamp from './node_modules/@kinvolk/headlamp-plugin/config/vite.config.mjs';

// What `headlamp-plugin test` sets for the run.
process.env.UNDER_TEST = 'true';

export default mergeConfig(headlamp, {
  resolve: {
    alias: [
      {
        find: /^@kinvolk\/headlamp-plugin\/lib\/k8s\/cluster$/,
        replacement: fileURLToPath(
          new URL(
            './node_modules/@kinvolk/headlamp-plugin/lib/lib/k8s/cluster.js',
            import.meta.url,
          ),
        ),
      },
    ],
  },
  test: {
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'lcov'],
      include: ['src/**'],
      // Tests, their fixtures and helpers (testdata/), and the type-only reference file.
      exclude: ['src/**/*.test.*', 'src/testdata/**', 'src/**/*.d.ts'],
      thresholds: { lines: 100, statements: 100, functions: 100, branches: 100 },
    },
  },
});
