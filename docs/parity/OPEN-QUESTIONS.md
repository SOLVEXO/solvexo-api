# Open questions / things the owner must supply

## Deferred (not in this run)
- Product subscriptions (selling plans)
- Shopify Functions / checkout extensibility
- 3PL fulfillment services
- A/B testing
- Third-party app platform (OAuth/extensions)
- FBR POS integration (needs FBR license or licensed partner)
- Safepay recurring (needs docs)
- Multi-wholesaler marketplace network
- Lending/credit

## Unverified external API fields
(Log each unknown here with the mapping file that isolates it, marked "VERIFY AGAINST OFFICIAL DOC".)
- **WhatsApp Cloud API webhooks** (statuses, inbound messages, button replies): `messaging-channels/whatsapp-webhook.mapping.ts`. Field names are from memory; confirm against Meta's current docs and a real test number.
- **WhatsApp messaging tier** (default 1000 unique contacts / 24 h) and per-message pricing: from memory, no price is shown anywhere; confirm in the store's Meta Business account.
- **WhatsApp template create/list** (`WhatsAppCloudProvider.createTemplate/listTemplates`, built earlier): not run against a live WABA.
- **Pakistani SMS gateways** (Jazz, Telenor, Zong, Ufone, bulk-SMS aggregators): no endpoint or field is known to us. Need from the owner: the official API document + a sandbox / test credentials for each gateway to be offered, to turn a placeholder preset into a verified one (`messaging-channels/sms.util.ts` PK_GATEWAY_PRESETS). Also: their delivery-report (DLR) and inbound-reply formats (`mapSmsDelivery` / `mapSmsInbound`), sender-ID (mask) rules, and whether PTA requires registration of a sender name / opt-out wording for marketing SMS.

## Keys / docs / sandboxes needed from the owner
(Filled in as phases are built.)
- P4: a WhatsApp Business test number (Meta developer app + System User token) to run the first real template submit / send / webhook; set `WHATSAPP_WEBHOOK_VERIFY_TOKEN` and the app secret; set `MESSAGING_CAMPAIGNS_ENABLED=true` only when ready.
- P4: API documentation and test credentials of at least one Pakistani SMS gateway.

## P7 Qisstpay
- Official merchant integration guide + sandbox credentials needed: auth, create-checkout/redirect call, webhook signature, status names, refund, minimum/maximum order value, installment plans. The adapter (providers/qisstpay.provider.ts) is registered but disabled, unverified, not connectable, and never charges; fill the mapping from the guide and test in sandbox before enabling. "Pay in installments" storefront wording (installmentMessage) is not shown anywhere until then.
