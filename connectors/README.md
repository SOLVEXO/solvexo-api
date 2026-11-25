# Connectors

Ready-made integrations that let Solvexo sellers connect their store to thousands of other tools. They use only the public Admin API, its OAuth install flow, and REST-hook webhooks.

| Folder | What | Test |
|---|---|---|
| `zapier/` | Solvexo for Zapier: 9 instant triggers and 3 actions | `cd zapier && npm install && npm test` |
| `make/` | Solvexo for Make: instant trigger, searches, actions and a general API call | `node --test make/check.test.mjs` |

Each connector is a normal Solvexo app. Register it once in **Super Admin → App platform** with its redirect address, approve it, then give its client id and secret to the connector (see each README). Sellers then connect with **Sign in with Solvexo**, pick a store and allow the permissions.

These folders are not part of the API build.
