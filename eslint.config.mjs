import tseslint from 'typescript-eslint';
import globals from 'globals';

// Minimal, non-type-aware lint gate. Type correctness is covered by
// `npm run typecheck`; this catches the other class of issues (duplicated keys,
// unreachable code, obviously wrong comparisons, ...). Rules that flag the
// legacy codebase en masse are downgraded to warnings so `npm run lint` stays a
// useful signal instead of a wall of noise.
export default tseslint.config(
    { ignores: ['node_modules/', 'public/', 'dist/', '**/*.d.ts'] },
    ...tseslint.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: { ...globals.node, ...globals.browser },
        },
        rules: {
            // The addon is compiled with `strict: false` and talks to loosely
            // typed Hydro internals, so `any` is used deliberately. Reporting it
            // here would bury the actionable warnings under ~1000 lines of noise.
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-unused-vars': ['warn', {
                argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none',
            }],
            '@typescript-eslint/no-require-imports': 'warn',
            '@typescript-eslint/no-empty-object-type': 'warn',
            '@typescript-eslint/no-unsafe-function-type': 'warn',
            '@typescript-eslint/no-this-alias': 'warn',
            'no-empty': ['warn', { allowEmptyCatch: true }],
            'no-useless-escape': 'warn',
            'no-control-regex': 'warn',
            'prefer-const': 'warn',
        },
    },
);
