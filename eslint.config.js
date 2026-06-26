import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
    {
        ignores: ["dist/", "node_modules/", "scratchpad/", "*.test.js"],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ["src/**/*.ts"],
        rules: {
            // Lib code shouldn't print to stdout/stderr — the CLI owns the console.
            "no-console": ["error", { allow: ["warn", "error"] }],
            // Warn on explicit any (event payloads/DB rows legitimately use it).
            "@typescript-eslint/no-explicit-any": "warn",
            // Allow unused args/vars prefixed with _ (intentional skips).
            "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
            // Dynamic import() type annotations are a legitimate pattern here
            // (ProjectionService references HadesEvent via import() to avoid a cycle).
            "@typescript-eslint/consistent-type-imports": "off",
            // Prefer const, but don't fail the build on it (let the fixer handle it).
            "prefer-const": "warn",
            // Stylistic rules below are noise for a prototype; revisit later.
            "preserve-caught-error": "off",
            "no-useless-assignment": "off",
        },
    },
    {
        // The CLI + pod entrypoints own the console (user-facing output).
        files: ["src/cli.ts", "src/brain-pod/cli.ts", "src/hands-pod/cli.ts", "src/adapters/api/server.ts"],
        rules: { "no-console": "off" },
    },
);
