# Recipe code

The code behind [the stack recipes](../../docs/recipes/README.md). Each
directory is one recipe; `stubs/` holds hand-written type stubs for the
frameworks, so that `tests/recipes-typecheck.test.ts` can type-check every
recipe against the SDK's source without installing them.

To check one recipe by hand, from the repository root:

```bash
pnpm exec tsc -p examples/recipes/express-bullmq-hubspot/tsconfig.json
```

The `tsconfig.json` files are for that check. In your own application, install
the dependencies the recipe's `package.json` lists and use your own
configuration.
