# Platform reference: what CrossTAK relies on in CloudTAK

CrossTAK is a CloudTAK plugin. CloudTAK is not ours and has no stable hook for what we do, so
this file records what we read from it, where it came from, and what we saw. Marks:
**✅ verified** = seen running on a real CloudTAK. **source** = read in CloudTAK's git history
only. Add to this file whenever a change teaches something new about CloudTAK.

## Where CloudTAK keeps its worker (native Share hook, `plugin/lib/send-hijack.ts`)

CloudTAK's Share sends a feature with `await mapStore.worker.conn.sendCOT(feat)`
(`app/src/components/CloudTAK/util/Share.vue`). That goes to the home TAK Server only.
CrossTAK puts its own `sendCOT` in front of it so a person seen through a link
(`crosstak:<link>:<uid>`) is sent over that link.

| CloudTAK | Where the worker lives | `mapStore.worker` getter |
|---|---|---|
| 13.102.0 to 14.4.0 | map store state, `_worker` | yes (source) |
| 14.4.1 and later | a module variable in `app/src/stores/map.ts`; the store keeps only `workerStarted` | yes (source; ✅ verified 2026-11-27 on 14.4.2) |

- Upstream commit `949a7f611` "Fix Logout Bugs" (2026-11-26) made the change. It is in 14.4.1 and
  14.4.2 and not in 14.4.0 (source: `git merge-base --is-ancestor`).
- A hook that sets `store._worker` therefore stops working from 14.4.1, silently. That was
  CrossTAK 0.6.0 and 0.6.1. Do not depend on a store field for the worker.
- The getter is the one thing every version has, and Share reads it on every send. CrossTAK
  replaces it: Pinia keeps each getter of an options store as a computed ref on the store's raw
  object (`toRaw(store).worker`). Ours reads CloudTAK's original ref, so it follows a new worker
  after logout and login by itself. ✅ verified 2026-11-27 on 14.4.2 in a real browser (Share to a
  linked person makes `POST /api/crosstak/send`; home contacts still go home; works again after
  an in-app sign-out and sign-in and after a reload). Before the change the same call made no request.
- This relies on a Pinia internal (a getter is a ref on the raw store). If a later CloudTAK
  changes the shape, the plugin logs `CrossTAK: this CloudTAK has no map store worker I can hook`
  and Share to a linked person goes home only; CrossTAK's own Send pane keeps working.
- The worker is a Comlink proxy. Do not try to set properties on it (a set goes to the worker
  thread) and do not put it through Vue's `reactive` (CloudTAK's own comment: the set trap
  recurses forever). We wrap it in a plain `Proxy` and `markRaw` it.

## When plugins are enabled

CloudTAK calls a plugin's `enable()` when the map has finished loading (`setPluginsEnabled(true)`
in `app/src/plugin-loader.ts`), and `disable()` first on every page load. A profile whose group
sync fails never gets a booted map, so no plugin is enabled: a browser test must sign in as a
profile whose `GET /api/marti/group` answers 200. ✅ verified 2026-11-27 (a profile without a
working TAK certificate gave "Failed to sync groups" and no CrossTAK menu).
