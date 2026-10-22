# <type>(<package>): <what> (<lane id>)

## Spec

Link: `docs/design/lanes/<NN>-<name>.md` (and the branch `feat/<package>-<task>`).
Lane id: <SBX-A-NN>. Time spent: <hours>.

## Evidence

Paste command output. Do not paste environment values, tokens or full ids.

```
$ corepack pnpm evidence --lane <NN>
<paste the result lines>
```

| Acceptance test | Command     | Result                  |
| --------------- | ----------- | ----------------------- |
| <name>          | `<command>` | <exit code, pass count> |

Red run (tests first): <command, failing count>
Green run: <command, pass count>

## Sanitised ids

Shorten every id to four characters plus an ellipsis. Write "none" if there are none.

- <abcd...>

## Assumptions and not done

- ASM-<LANE>-1: <assumption>
- Not done: <item, reason>

## Reviewer checklist

- [ ] The change stays inside the files the spec lists; no feature package edited by another lane.
- [ ] Tests were committed first and ran red; no test was edited to pass (or the spec contradiction is stated).
- [ ] No dependency outside the approved list; lockfile diff reviewed (SUP-1, SUP-4).
- [ ] No secret, token, credential, `.env.local` or live PayPal hostname anywhere in the diff (gitleaks clean).
- [ ] No `Date.now()`, `new Date()`, `Math.random()`, `performance.now()` or `crypto.randomUUID()` outside `packages/runtime`.
- [ ] `corepack pnpm ci` output attached and green.
- [ ] Mutation, bundle and fixture checks attached when the change touches a money module, the web build or fixtures.
- [ ] Each fixture is labelled `docs-example`, `synthetic` or `sandbox-recording` and listed in the index.
- [ ] Control ids from nfr.md 1.3 touched by this change are named, with proof.

Simulation tests prove the modelled cases only, not PayPal compatibility.
