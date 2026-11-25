# Solvexo for Zapier

A Zapier integration built on the public Solvexo Admin API (`https://www.solvexo.store/developers`).

**Triggers (instant):**
- New Order
- Order Paid
- Order Shipped
- Order Cancelled
- Order Refunded
- New Customer
- Product Created or Updated
- Stock Level Changed
- New Form Submission

**Actions:**
- Ship Order: ships everything not shipped yet, with tracking.
- Adjust Stock
- Update Product: status and tags.

Sign-in is Solvexo OAuth. The store owner signs in, picks a store and allows the permissions. Each Zap subscribes its own webhook when it's turned on and removes it when it's turned off.

## Publish it (one time)

You need a free Zapier developer account (https://developer.zapier.com) and Node 18 or later.

1. **Register the Zapier app in Solvexo.** In Super Admin, open App platform and choose Register app:
   - **Name:** Zapier
   - **Developer:** Solvexo
   - **Permissions:** `read_orders write_orders read_products write_products read_customers read_inventory write_inventory`
   - **Redirect address:** leave a placeholder for now. Step 3 gives you the real one.
   - Keep the **client id** and **client secret** it shows.
2. **Create the Zapier integration:**
   ```bash
   cd connectors/zapier && npm install
   npx -p zapier-platform-cli@19.3.0 zapier-platform login
   npx -p zapier-platform-cli@19.3.0 zapier-platform register "Solvexo"
   npx -p zapier-platform-cli@19.3.0 zapier-platform push
   ```
   `npx -p zapier-platform-cli@19.3.0` runs Zapier's command tool (the same version as `zapier-platform-core`) without installing it. Keep it out of this project's `node_modules`: `push` copies the folder, and the tool's hundreds of packages cause "EMFILE: too many open files" on Windows. Its command is `zapier-platform`; older guides call it `zapier`. Shortcut: `npm run zapier -- push`.
3. **Get the redirect address.** `npx -p zapier-platform-cli@19.3.0 zapier-platform describe` shows it, for example `https://zapier.com/dashboard/auth/oauth/return/App123456CLIAPI/`. Put that exact address into the Solvexo app's redirect addresses, then approve the app in Super Admin.
4. **Give Zapier the keys** from step 1:
   ```bash
   npx -p zapier-platform-cli@19.3.0 zapier-platform env:set 1.0.0 CLIENT_ID=app_xxx CLIENT_SECRET=appsec_xxx
   ```
5. **Try it.** In Zapier, make a Zap with a Solvexo trigger and connect a **development store** (Build apps → Development stores). Place a draft order and check the Zap runs.
6. **Release it.** Invite testers with `npx -p zapier-platform-cli@19.3.0 zapier-platform users:add` or share the invite link. When you're ready for everyone, `npx -p zapier-platform-cli@19.3.0 zapier-platform promote 1.0.0` and submit it for Zapier's public review.

For a staging API, set `SOLVEXO_API_URL` and `SOLVEXO_WEB_URL` with `npx -p zapier-platform-cli@19.3.0 zapier-platform env:set` as well.

## Develop

```bash
npm install
npm test   # checks the app against Zapier's schema and runs every trigger and action against a fake Solvexo API
```
