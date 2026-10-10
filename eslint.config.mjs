import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier";
import tailwindcss from "eslint-plugin-tailwindcss";
import tseslint from "typescript-eslint";

const enabledStrictTypeScriptRules = [
  // Enable rules only after an audit confirms zero current findings.
  "@typescript-eslint/await-thenable",
  "@typescript-eslint/restrict-plus-operands",
  "@typescript-eslint/prefer-promise-reject-errors",
  "@typescript-eslint/no-array-delete",
  "@typescript-eslint/no-for-in-array",
  "@typescript-eslint/require-await",
  "@typescript-eslint/no-floating-promises",
  "@typescript-eslint/no-explicit-any",
  "@typescript-eslint/no-unsafe-enum-comparison",
  "@typescript-eslint/no-duplicate-type-constituents",
  "@typescript-eslint/no-unsafe-call",
  "@typescript-eslint/no-unsafe-argument",
  "@typescript-eslint/no-unsafe-assignment",
  "@typescript-eslint/no-unsafe-member-access",
  "@typescript-eslint/no-unsafe-return",
  "@typescript-eslint/no-unsafe-unary-minus",
  "@typescript-eslint/no-unsafe-function-type",
  "@typescript-eslint/no-redundant-type-constituents",
  "@typescript-eslint/use-unknown-in-catch-callback-variable",
  "@typescript-eslint/no-base-to-string",
  "@typescript-eslint/no-deprecated",
  "@typescript-eslint/no-unnecessary-type-assertion",
  "@typescript-eslint/no-duplicate-enum-values",
  "@typescript-eslint/no-unnecessary-type-arguments",
  "@typescript-eslint/no-unnecessary-type-constraint",
  "@typescript-eslint/no-unnecessary-boolean-literal-compare",
  "@typescript-eslint/no-unnecessary-template-expression",
  "@typescript-eslint/no-confusing-void-expression",
  "@typescript-eslint/no-misused-promises",
  "@typescript-eslint/only-throw-error",
  "@typescript-eslint/switch-exhaustiveness-check",
  "@typescript-eslint/no-unnecessary-condition",
  "@typescript-eslint/no-non-null-assertion",
  "@typescript-eslint/ban-ts-comment",
  "@typescript-eslint/no-array-constructor",
  "@typescript-eslint/no-extra-non-null-assertion",
  "@typescript-eslint/no-extraneous-class",
  "@typescript-eslint/no-implied-eval",
  "@typescript-eslint/no-meaningless-void-operator",
  "@typescript-eslint/no-misused-new",
  "@typescript-eslint/no-mixed-enums",
  "@typescript-eslint/no-namespace",
  "@typescript-eslint/no-non-null-asserted-nullish-coalescing",
  "@typescript-eslint/no-non-null-asserted-optional-chain",
  "@typescript-eslint/no-require-imports",
  "@typescript-eslint/no-this-alias",
  "@typescript-eslint/no-unsafe-declaration-merging",
  "@typescript-eslint/no-useless-constructor",
  "@typescript-eslint/no-useless-default-assignment",
  "@typescript-eslint/no-wrapper-object-types",
  "@typescript-eslint/prefer-as-const",
  "@typescript-eslint/prefer-literal-enum-member",
  "@typescript-eslint/prefer-namespace-keyword",
  "@typescript-eslint/prefer-reduce-type-parameter",
  "@typescript-eslint/prefer-return-this-type",
  "@typescript-eslint/related-getter-setter-pairs",
  "@typescript-eslint/triple-slash-reference",
  "@typescript-eslint/unbound-method",
  "@typescript-eslint/unified-signatures",
  "@typescript-eslint/no-unnecessary-type-parameters",
  "@typescript-eslint/no-unnecessary-type-conversion",
  "@typescript-eslint/restrict-template-expressions",
  "@typescript-eslint/no-dynamic-delete",
  "@typescript-eslint/no-empty-object-type",
  "@typescript-eslint/no-misused-spread",
  "@typescript-eslint/return-await",
  "@typescript-eslint/no-invalid-void-type",
  "@typescript-eslint/prefer-nullish-coalescing",
  "@typescript-eslint/consistent-type-imports",
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
    ignores: ["src/components/ui/**"],
    plugins: {
      tailwindcss,
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    settings: {
      tailwindcss: {
        cssConfigPath: "./src/app/globals.css",
      },
    },
    rules: {
      ...strictTypeScriptRules,
      ...Object.fromEntries(enabledStrictTypeScriptRules.map((rule) => [rule, "error"])),
      "no-unused-vars": "off",
      "no-unused-private-class-members": "error",
      "no-unused-expressions": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "all",
          argsIgnorePattern: "^_",
          caughtErrors: "all",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
          varsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-unused-expressions": "error",
      ...tailwindcss.configs.recommended.rules,
      "tailwindcss/no-custom-classname": [
        "warn",
        { whitelist: ["eyebrow", "actionButton", "no-scrollbar"] },
      ],
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
