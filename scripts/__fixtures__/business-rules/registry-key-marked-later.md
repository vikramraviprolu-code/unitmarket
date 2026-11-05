# Fixture: section 3 key table (BR-10 drift check)

| Key | Reference | Unit | Default | Safe range | Scopes | When buyer and seller settings differ | Tier | Slice |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `refund.request_window` | BR-REF-13 | days after access starts | 7 (D-096) | 0..30 | platform, category, seller, buyer, agreement | the longer one (buyer protection) | A | later |
| `access.window` | BR-ACC-1 | days | 5 | 1..30; raised to `refund.request_window` if shorter | platform, category, seller, offer | seller's setting | A | BR-1 |
| `mandate.max_days` | BR-MAN-2 | days | 90 | 1..90 | platform, buyer | the lower one | A | BR-1 |
| `refund.who_decides` | BR-REF-1 | enum | operator | fixed list | platform, seller | seller's setting | B | later |
| `basket.max_items` | BR-APR-4 | count | 5 | 1..5 | platform | platform only | A | later |
