import js from "@eslint/js";
import tseslint from "typescript-eslint";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.astro/**",
      "**/build/**",
      "**/*.d.ts",
      "**/*.astro",
      "references/**",
      "for-pf-theme/**",
      "infra/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.es2021 },
    },
    rules: {
      // Allow `_` prefix to mark intentionally-unused params and vars.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
      // The codebase uses `any` deliberately in a number of places (Hono context
      // narrowing, dynamic API responses); flag with warn rather than error.
      "@typescript-eslint/no-explicit-any": "warn",
      // Empty catch blocks are used intentionally for best-effort operations.
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  // Browser-side code (React, Astro) — add DOM globals.
  {
    files: ["packages/web/**/*.{ts,tsx,jsx,astro}"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { react, "react-hooks": reactHooks },
    settings: { react: { version: "detect" } },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      // React 17+ JSX transform — no need to import React in scope.
      "react/react-in-jsx-scope": "off",
      // Astro doesn't expose prop-types and we use TS for prop validation.
      "react/prop-types": "off",
      // Cosmetic — we don't need to escape quotes inside JSX text.
      "react/no-unescaped-entities": "off",
    },
  },
);
