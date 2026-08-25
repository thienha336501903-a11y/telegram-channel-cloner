# Clone Factory configuration

The Cloner code is shared by every cloned system. Clone identity, Reader URL,
LMS URL, V4 URL and additional allowed origins come from environment variables;
server code must read them through `lib/clone-config.js`.

System B remains the compatibility default when the new variables are absent.
This keeps the current Production deployment and existing Reader installers
working. A new system must set the public URL variables in `.env.example` before
its first deployment. Desktop Reader tools accept `CLONER_URL` explicitly.

Safe client-side values are exposed by `/api/public-config.js`. Secrets remain
server-only and are never included in that response.

Run `npm test`, `npm run check`, and `npm run check:clone` before deployment.
