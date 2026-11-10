# Cloud runbook: start, stop, check and deploy the hosted sandbox

For the owner and Sakthi, from a laptop or Cloud Shell. One kit, seven commands, in `infra/gcp/cloud.sh`. Names come from `infra/gcp/stack.env` (project `unitmarket-sbx-vr1`, region `europe-west3`). Decision D-049 and the row that amends it in `docs/decision-log.md` are the rules behind it.

Two things hold for every command. The kit never turns PayPal on: no command here sets the flag `UMS_PAYPAL_CONNECT` to on (since D-120 `service.yaml` carries it on, and `cloud:down` still sets it off). A PayPal call still needs a sitting opened on Operations Controls with the authenticator code and the Start switch. And agents never run this kit for real: builder and reviewer agents use a fake `gcloud` only (D-049).

## Before the first use

Run `corepack pnpm cloud:doctor`. It checks the tools, the active account, the APIs, the secret names, the database and the newest backup. It prints two `gcloud config set` lines for you to paste yourself if the account or project is not set. It never runs them.

Every command takes `--dry-run`: it prints the changing calls and makes only read calls. Exit codes: 0 done, 1 failed, 2 refused, 64 bad usage. With no terminal, every question is a refusal.

## Everyday commands

| Command                          | What it does                                                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `corepack pnpm cloud:status`     | State of the web service, job loop, database, offline service and PayPal flag. `--json` for the machine form.           |
| `corepack pnpm cloud:up`         | Starts the database, then the web service (1 instance, CPU always on), then checks `/api/v1/status`.                    |
| `corepack pnpm cloud:down`       | Sets the PayPal flag off first, then stops the web service (min 0, internal only) and the database. Nothing is deleted. |
| `corepack pnpm cloud:restart`    | New revision of the same image with the same settings.                                                                  |
| `corepack pnpm cloud:logs`       | Last 100 log lines. `--lines 300` or `--errors` to change.                                                              |
| `corepack pnpm cloud:deploy TAG` | Deploys a reviewed tag (see below).                                                                                     |

`down` asks you to type the service name. It warns when the newest backup is older than 24 hours, because a stopped database takes no backups. After `down`, the app is unreachable until `up`.

## Deploy a reviewed commit

1. In a clean clone, check out the reviewed tag: `git fetch --tags`, then `git checkout TAG`. The kit never tags, fetches or checks out for you.
2. Run `corepack pnpm cloud:deploy TAG --dry-run`, read the calls, then run it without `--dry-run`.
3. It refuses a dirty tree, a HEAD that is not at the tag, and a newest backup older than 24 hours. Take a fresh backup first. Use `--accept-old-backup` only when the owner agrees.
4. When it finishes it prints a block under `== paste back` with the tag, commit, revision, URL, health and flag. Paste that block into the thread.
5. After a deploy the PayPal flag is on (from `service.yaml`, D-120), but no call goes out until an operator opens a sitting on Operations Controls and presses Start.

## If something is wrong

- Exit 2 with a message: a precondition is not met. Read the message; do not work around it.
- Exit 1 after `up`: run `corepack pnpm cloud:status` and `corepack pnpm cloud:logs --errors`.
- Never paste a secret value, a token or a password into a thread. Names only.
