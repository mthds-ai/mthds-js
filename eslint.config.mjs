import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/**", "coverage/**"],
  },
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.es2022,
        fetch: "readonly",
        Headers: "readonly",
        Request: "readonly",
        Response: "readonly",
        DOMException: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": "error",
    },
  },
  {
    // CLI entrypoints and command modules intentionally write user-facing output.
    files: ["src/cli.ts", "src/agent-cli.ts", "src/cli/**/*.ts", "src/agent/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },
  {
    // Tests use console spies and subprocess output assertions.
    files: ["tests/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },
];
