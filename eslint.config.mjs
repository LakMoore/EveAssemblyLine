import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

const enabledStrictTypeScriptRules = [
  // Add one rule at a time as the codebase is cleaned up.
  // "@typescript-eslint/no-floating-promises",
  "@typescript-eslint/no-unnecessary-condition",
  // "@typescript-eslint/no-non-null-assertion",
];

const strictTypeScriptRules = Object.fromEntries(
  tseslint.configs.strictTypeChecked.flatMap((config) =>
    Object.keys(config.rules ?? {}).map((rule) => [rule, "off"]),
  ),
);

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    excludedFiles: ["src/app/components/ui/**"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      ...strictTypeScriptRules,
      ...Object.fromEntries(enabledStrictTypeScriptRules.map((rule) => [rule, "error"])),
    },
  },
  prettier,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
