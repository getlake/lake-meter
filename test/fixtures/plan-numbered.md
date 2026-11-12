Here is my plan:

1. Rename `getUser` to `fetchUser` across the codebase
2. Refactor the auth middleware to support OAuth refresh tokens securely
   - update src/auth/middleware.ts and src/auth/tokens.ts
3. Add a loading spinner component to the settings page
4. Bump the eslint version and fix lint warnings
