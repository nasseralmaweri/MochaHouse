import type { Config } from "jest";

// Minimal Jest for pure-logic unit tests only (no jsdom, no React Testing
// Library) — Milestone 5C's Admin nav + location-context modules are
// framework-free by design. Component behaviour is covered by the build,
// TypeScript, and the API integration tests.
const config: Config = {
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["<rootDir>/src/**/*.spec.ts"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
  },
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        tsconfig: {
          module: "commonjs",
          moduleResolution: "node",
          esModuleInterop: true,
          jsx: "react-jsx",
          types: ["jest", "node"],
        },
      },
    ],
  },
};

export default config;
