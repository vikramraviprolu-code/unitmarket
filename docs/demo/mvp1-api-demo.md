# MVP 1 API demo: an AI agent with a $5.00 cap buys, step by step

This is the story that `tests/mvp1-api/e2e.integration.test.ts` (steps P1-01 to P1-11) tells, as curl commands you can run against your own local app. Everything is dry-run: the payment provider is the app's pretend order model, the webhook receiver is an in-process sink, and nothing reaches PayPal or any network. "Passing" here proves the modelled cases only, not PayPal compatibility.

The automated test buys 50 units of $0.10 under a $5.00 money cap (60 purchases allowed), so the money cap is what stops the agent. The seeded catalogue has no 50 cheap units, so this walkthrough uses a $5.00 cap with a limit of 3 purchases on the three seeded Harbour Ledger units; the count cap stops the agent here. Same routes, same answers in shape.

All values below are placeholders (`<...>`). Ids and tokens in the expected answers are shortened; yours will differ. Never paste a real passcode, key or token into a document, a log or a chat.

## Setup (once)

You need Node 22.22.0, Corepack, `curl` and `jq`. Follow "Run it offline in under ten minutes" in `README.md` (`owner:secrets`, `apps/web/.env.local`, build, start), with two additions in `apps/web/.env.local` so the story can use the seller and the operator second factor:

```sh
UMS_PUBLISHER_PASSCODE_HASH=<hash from owner:secrets, a different passcode>
UMS_OPERATOR_TOTP_KEYS=vikram:<base32 secret from: corepack pnpm totp:enrol --operator vikram>
```

Check the app: `curl -s http://localhost:3000/healthz` answers `{"ok":true,"environment":"dryrun"}`.

Shell helpers used below:

```sh
H=http://localhost:3000
O='Origin: http://localhost:3000'
J='Content-Type: application/json'
# the session cookie of a sign-in answer saved with -D <file>
cookie() { grep -i '^set-cookie' "$1" | sed 's/^[Ss]et-[Cc]ookie: //; s/;.*//' | tr -d '\r'; }
```

Two rules of the routes: a session call sends the cookie, `Origin` and `X-CSRF-Token`; a key call sends `Authorization: Bearer <token>` and, for every change, an `Idempotency-Key` (8 to 128 letters, digits, `_` or `-`).

## P1-01 A buyer signs in and issues an agent key

```sh
curl -sS -D b.hdr -H "$O" -H "$J" -d '{"persona":"buyer-a","passcode":"<DEMO_PASSCODE>"}' $H/api/session > b.json
BC=$(cookie b.hdr); BCSRF=$(jq -r .csrf_token b.json)
```

Expected: `{"csrf_token":"<32 hex>","actor_kind":"buyer"}`.

```sh
curl -sS -H "$O" -H "$J" -H "Cookie: $BC" -H "X-CSRF-Token: $BCSRF" -H "Idempotency-Key: demo-agent-key-0001" \
  -d '{"key_kind":"agent","scopes":["catalogue:read","agent:buy"]}' $H/api/v1/api-keys > agent.json
AGENT=$(jq -r .token agent.json); AGENT_ID=$(jq -r .id agent.json)
```

Expected (201): `id` `key_...`, `key_kind` `agent`, `scopes` `["agent:buy","catalogue:read"]`, and a `token` starting `umk_`. The token is shown once. The buyer also issues a client key that can set the cap and read events and orders:

```sh
curl -sS -H "$O" -H "$J" -H "Cookie: $BC" -H "X-CSRF-Token: $BCSRF" -H "Idempotency-Key: demo-client-key-0001" \
  -d '{"key_kind":"api_client","scopes":["mandates:write","events:read","orders:read"]}' $H/api/v1/api-keys > client.json
CLIENT=$(jq -r .token client.json)
```

## P1-02 The buyer sets the cap

```sh
EXP=$(date -u -d '+24 hours' +%Y-%m-%dT%H:%M:%S.000Z)
curl -sS -H "$J" -H "Authorization: Bearer $CLIENT" -H "Idempotency-Key: demo-mandate-0001" \
  -d "{\"agent_key_id\":\"$AGENT_ID\",\"currency\":\"USD\",\"max_total_minor\":500,\"max_count\":3,\"expires_at\":\"$EXP\",\"terms_accepted\":true}" \
  $H/api/v1/mandates
```

Expected (201): `{"id":"man_...","agent_key_id":"<AGENT_ID>","currency":"USD","max_total_minor":500,"max_count":3,"spent_minor":0,"used_count":0,"remaining_total_minor":500,"remaining_count":3,"revoked_at":null,...}`. The cap is money, a purchase count, or both; at least one is required. The agent key cannot do this call itself: send it with `$AGENT` and the answer is 403.

## P1-03 An operator with the second factor turns agent buying on

Agent buying is off by default. With a cap and a key, the agent is still refused:

```sh
buy() { curl -sS -H "$J" -H "Authorization: Bearer $AGENT" -H "Idempotency-Key: $2" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"buy_unit\",\"arguments\":{\"publisher\":\"harbour-ledger\",\"offer\":\"$1\",\"idempotency_key\":\"$2\"${3:-}}}}" \
  $H/api/v1/mcp | jq -c '.result.structuredContent'; }
buy tide-tables demo-buy-0000
```

Expected: `{"status":"agent_buy_disabled","message":"Agent buying is switched off right now."}`.

An operator who signed in without the authenticator code cannot turn it on:

```sh
curl -sS -D o0.hdr -H "$O" -H "$J" -d '{"persona":"operator","passcode":"<DEMO_PASSCODE>","operator":"vikram"}' $H/api/session > o0.json
OC0=$(cookie o0.hdr); OCSRF0=$(jq -r .csrf_token o0.json)
curl -sS -H "$O" -H "$J" -H "Cookie: $OC0" -H "X-CSRF-Token: $OCSRF0" -d '{"on":true,"reason":"demo without code"}' $H/api/ops/agent-buy
```

Expected: sign-in `{"csrf_token":"...","actor_kind":"operator","mfa":false}`, then 403 `{"error":{"code":"mfa_required",...}}`.

With the code from your authenticator app:

```sh
curl -sS -D o1.hdr -H "$O" -H "$J" -d '{"persona":"operator","passcode":"<DEMO_PASSCODE>","operator":"vikram","code":"<6-DIGIT CODE>"}' $H/api/session > o1.json
OC1=$(cookie o1.hdr); OCSRF1=$(jq -r .csrf_token o1.json)
curl -sS -H "$O" -H "$J" -H "Cookie: $OC1" -H "X-CSRF-Token: $OCSRF1" -d '{"on":true,"reason":"demo with code"}' $H/api/ops/agent-buy
```

Expected: sign-in has `"mfa":true`, then `{"agent_buy_on":true}`. A switch change reaches the agent within 5 seconds (the switch reader caches for at most 5 s): `sleep 6` before the next step.

## P1-04 The seller issues a key and both sides subscribe to events

```sh
curl -sS -D p.hdr -H "$O" -H "$J" -d '{"persona":"publisher-harbour-ledger","passcode":"<PUBLISHER_PASSCODE>"}' $H/api/session > p.json
PC=$(cookie p.hdr); PCSRF=$(jq -r .csrf_token p.json)
curl -sS -H "$O" -H "$J" -H "Cookie: $PC" -H "X-CSRF-Token: $PCSRF" -H "Idempotency-Key: demo-seller-key-0001" \
  -d '{"key_kind":"api_client","scopes":["events:read","offers:write","sales:read"]}' $H/api/v1/api-keys > seller.json
SELLER=$(jq -r .token seller.json)
```

`order.paid` belongs to the buyer, so the seller key may not ask for it:

```sh
curl -sS -H "$J" -H "Authorization: Bearer $SELLER" -H "Idempotency-Key: demo-sub-0000" \
  -d '{"url":"https://seller.example.com/hooks/unitmarket","event_types":["order.paid","sale.recorded"]}' $H/api/v1/webhook-subscriptions
```

Expected: 403 `{"error":{"code":"event_type_not_allowed",...}}`. The seller subscribes to its own event, and the buyer's client key to the buyer's:

```sh
curl -sS -H "$J" -H "Authorization: Bearer $SELLER" -H "Idempotency-Key: demo-sub-0001" \
  -d '{"url":"https://seller.example.com/hooks/unitmarket","event_types":["sale.recorded"]}' $H/api/v1/webhook-subscriptions > sellersub.json
curl -sS -H "$J" -H "Authorization: Bearer $CLIENT" -H "Idempotency-Key: demo-sub-0002" \
  -d '{"url":"https://buyer.example.com/hooks/unitmarket","event_types":["order.paid","mandate.exhausted"]}' $H/api/v1/webhook-subscriptions > buyersub.json
```

Expected (201 each): `id` `wsb_...`, the `event_types` you asked for, and a `signing_secret` `whsec_<64 hex>` shown once. Keep it; a receiver verifies each delivery with it. The URLs are examples: in this build the app's sender is an in-process sink and opens no connection.

## P1-05 The agent lists the tools and reads its budget over MCP

```sh
curl -sS -H "$J" -H "Authorization: Bearer $AGENT" -H "Idempotency-Key: demo-list-0001" \
  -d '{"jsonrpc":"2.0","id":7,"method":"tools/list"}' $H/api/v1/mcp | jq -c '[.result.tools[].name]'
curl -sS -H "$J" -H "Authorization: Bearer $AGENT" -H "Idempotency-Key: demo-budget-0001" \
  -d '{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"check_budget","arguments":{}}}' $H/api/v1/mcp | jq -c '.result.structuredContent'
```

Expected: `["search_catalogue","get_offer","propose_pack","open_unit","check_budget","buy_unit"]`, then `{"status":"active","mandate_id":"man_...","currency":"USD","remaining_total_minor":500,"remaining_count":3,...}`. With no cap the answer would be `mandate_required` with an `ask_buyer` text that names money, purchases and expiry.

## P1-06 The agent buys until the cap says stop

```sh
buy tide-tables demo-buy-0001
buy ferry-timetables demo-buy-0002
buy harbour-fees demo-buy-0003 ',"option":"online_read"'
```

Expected, each: `{"status":"bought","order_ref":"ord_...","items":[{"entitlement_id":"ent_...","title":"...","publisher":"Harbour Ledger Review (fictional)"}],"environment":"dryrun","remaining_total_minor":<less each time>,"remaining_count":2}` then 1 then 0. A retry with the same `idempotency_key` buys once.

## P1-07 The next purchase is refused

```sh
buy knot-notebook demo-buy-0004
```

Expected: `{"status":"cap_exhausted"}`, and the call's `isError` is true. No order row is written; the buyer still has 3 orders:

```sh
curl -sS -H "Authorization: Bearer $CLIENT" "$H/api/v1/orders?limit=10" | jq -c '[.items[].status]'
```

Expected: `["paid","paid","paid"]`. One `mandate.exhausted` event now exists (reason `count` here, `money` in the automated 50-unit run).

## P1-08 Signed events reach the sinks

The app's job loop runs a delivery pass every few seconds; wait about 6 seconds, then:

```sh
SID=$(jq -r .id sellersub.json); BSID=$(jq -r .id buyersub.json)
curl -sS -H "Authorization: Bearer $SELLER" "$H/api/v1/webhook-subscriptions/$SID/deliveries" | jq -c '[.items[]|{event_type,status}]'
curl -sS -H "Authorization: Bearer $CLIENT" "$H/api/v1/webhook-subscriptions/$BSID/deliveries" | jq -c '[.items[]|{event_type,status}]'
curl -sS -H "Authorization: Bearer $SELLER" $H/api/v1/seller/sales | jq -c '[.items[]|{amount_minor,status}]'
```

Expected: three `sale.recorded` rows, all `delivered`; for the buyer, three `order.paid` and one `mandate.exhausted`, all `delivered`; and three sales with status `captured_verified`. Each delivery carries `UnitMarket-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" keyed by the signing secret>`. The automated test checks all 101 signatures with `verifySignature` (`apps/web/src/api-v1/signature.ts`); a receiver does the same with the secret from P1-04.

## P1-09 The operator stops agent buying and the next purchase is refused

The stop button needs an operator but no second factor (stopping only reduces what the system may do). It turns PayPal outbound off and, with it, agent buying:

```sh
curl -sS -H "$O" -H "$J" -H "Cookie: $OC0" -H "X-CSRF-Token: $OCSRF0" -d '{"reason":"demo stop"}' $H/api/ops/stop
sleep 6
buy village-bus demo-buy-0005
```

Expected: `{"outbound_on":false}`, then `{"status":"agent_buy_disabled","message":"Agent buying is switched off right now."}`. Turning it back on needs the second factor (P1-03).

## P1-10 No key can start or stop anything

```sh
curl -sS -o /dev/null -w "%{http_code}\n" -H "$J" -H "Authorization: Bearer $AGENT" -d '{"reason":"agent tries"}' $H/api/ops/stop
curl -sS -o /dev/null -w "%{http_code}\n" -H "$J" -H "Authorization: Bearer $SELLER" -d '{"reason":"seller tries","confirm_scope":"none"}' $H/api/ops/start
```

Expected: `401` and `401`. These controls take a signed-in operator session only.

## P1-11 The routes are in the OpenAPI document

`docs/api/openapi-v1.json` lists every `/api/v1` route used above: `api-keys`, `mandates`, `mcp`, `webhook-subscriptions`, `webhook-subscriptions/{id}/deliveries`, `seller/sales` and `orders`. `corepack pnpm check:openapi` fails if the file is stale. The session routes (`/api/session`, `/api/ops/agent-buy`, `/api/ops/stop`, `/api/ops/start`) are the web app's own and are not in the v1 document.

## What this does not show

- **The PayPal sandbox.** In sandbox mode `buy_unit` does not settle: it answers `buyer_approval_required` with a UnitMarket page link, and the buyer approves and pays each order there (no saved payment method, no Vault). That path needs the owner's approval row and the five locks, and is not part of this demo. Lane B's eval E-B4 covers it with zero transport calls.
- **Real receivers.** The webhook sender is an in-process sink in this build; a real HTTP sender comes later through `packages/transport`.
