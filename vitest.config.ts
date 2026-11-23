import { defineConfig } from 'vitest/config'

/**
 * Tests that compare durations. They run in a project of their own, after every other
 * test file has finished, one file at a time, so no other test shares the CPU while
 * they measure.
 */
const TIMING = 'src/**/*.timing.test.ts'

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['src/**/*.test.ts'], exclude: [TIMING] } },
      {
        test: {
          name: 'timing',
          include: [TIMING],
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
})
