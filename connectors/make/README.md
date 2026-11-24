# Solvexo for Make

A Make custom app built on the public Solvexo Admin API (`https://www.solvexo.store/developers`).

**Modules:**
- Watch Events (instant): new order, paid, shipped, cancelled, refunded, new customer, product changed, stock changed, form sent.
- Get an Order
- Search Orders
- Search Customers
- Ship an Order: everything not shipped yet, with tracking.
- Adjust Stock
- Update a Product
- Make an API Call

Each file here is what you paste into one tab of Make's app editor. `node --test check.test.mjs` checks the files stay in step with the API, with no Make account needed.

## Set it up (one time)

You need a Make account. Custom apps are under **Custom apps** in the left menu; on some plans it's **Organization → Apps**.

1. **Register the Make app in Solvexo.** In Super Admin, open App platform and choose Register app:
   - **Name:** Make
   - **Developer:** Solvexo
   - **Permissions:** `read_orders write_orders read_products write_products read_customers read_inventory write_inventory`
   - **Redirect address:** `https://www.make.com/oauth/cb/app` (for an EU or US Make zone, use that zone's address shown in Make's connection settings).
   - **Approve** the app, then keep its **client id** and **client secret**.
2. **In Make, create a custom app** called "Solvexo" with the Solvexo logo, then fill in each tab:

   | Make editor tab | Paste |
   |---|---|
   | Base | `base.json` |
   | Connections → new, type **OAuth 2 (authorization code)** → Communication | `connection.communication.json` |
   | that connection → Common data | `connection.common.json`, with the client id and secret from step 1 |
   | Webhooks → new, type **Dedicated, attached**, linked to the connection → Communication | `webhook.communication.json` |
   | that webhook → Parameters | `webhook.parameters.json` |

   Name the webhook `solvexoEvent`, which is what `watch_events.json` refers to.
3. **Add the modules.** For each file in `modules/`, add a module with the same name and type: "instant trigger", "action" or "search", as the file says. Paste its `communication`, `mappableParameters` and `interface` parts into the tabs of the same names, and its `samples` into Samples where present. Link Watch Events to the `solvexoEvent` webhook, and every module to the connection.
4. **Test it** with a **development store** (Build apps → Development stores):
   - Run Watch Events (Order paid), then place and pay a draft order in the test store.
   - Try Search Orders and Ship an Order on that order.
5. **Share it.** Use **Install** or **Share** for your team. To publish it for everyone, ask Make to review it from the app's page.

## Things to check in Make's editor

Make's expression language has a few spots that vary between Make versions and zones, so try these the first time:

- **State parameter:** the connection sends `state: {{md5(now)}}`. Solvexo only checks that a state is present and returns it unchanged.
- **Ship an Order:** the Idempotency-Key is built from the order id and tracking number, so a retried run doesn't ship twice. Leaving out the line items makes the API ship everything not yet shipped.
- **Adjust Stock / Update a Product:** these use `{{uuid}}` for a fresh key each run.
