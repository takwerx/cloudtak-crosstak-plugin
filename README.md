# CrossTAK

A [CloudTAK](https://github.com/dfpc-coe/CloudTAK) plugin that shows other agencies' TAK
Servers on the CloudTAK map. Each user links the servers they already have an account on, so
they work in one CloudTAK instead of one per agency. Each **linked server** is a separate,
directly enrolled connection, not federation: the linked servers never see each other, and your
home TAK Server receives nothing from them.

Status: pre-release (v0.6.0). Tested on CloudTAK 13.123 with TAK Server 5.8 linked servers.

## Install

- **TAK Portal:** install CrossTAK from the CloudTAK marketplace.
- **Standalone CloudTAK:** clone this repo next to your CloudTAK checkout and run
  `./install.sh /path/to/CloudTAK` (`--pull` to update, `--remove` to uninstall). It copies
  `plugin/` to `app/plugins/crosstak/` and `server/plugin-crosstak.ts` to `api/stateless/routes/`,
  then rebuilds and restarts the CloudTAK API. Afterwards use CloudTAK's Settings → Refresh App.

Requires CloudTAK 13.102 or newer (the `app/` layout and the 13.45 hub/api split).

## How it works

```
linked TAK Server ──8089, its CA pinned on this socket only──▶ plugin-crosstak.ts (inside the CloudTAK API process)
                                                                │  one node-tak stream per user per linked server
                                                                │  id → crosstak:<server>:<uid>, metadata.crosstak, archived:false
                                                                ▼
                                                    config.hub.wsNotify(owner, {type:'cot', data})   ← CloudTAK's public hub call
                                                                │
                                                                ▼
                                                the owner's existing CloudTAK WebSocket → native ingest → map
```

- Nothing in CloudTAK is patched. The server half is a route file CloudTAK's routes glob
  loads at boot; the web half is a normal CloudTAK web plugin.
- Linked features arrive through the same path as home-server features, with the safe
  defaults: never `authored`, never filed into a mission, never pushed anywhere, removed when
  `stale` passes, kept across reloads.
- **Per user (D2, 2026-11-17).** Every link belongs to the CloudTAK user who made it. Its
  stream uses that user's own certificate on the linked server, and its CoT goes to that user's
  browser only. Other users do not see the link or its data, and the API answers 404 for it.
  What a link sees is decided by that user's channels on the linked server.
- Streams are presence-driven: a link's socket opens while its owner is on the map and closes
  60 s after they leave. There is no always-on mode (it would show the person as online on the
  linked server while they are not).
- Leavers: once an hour (and at start) CrossTAK deletes the links, with their stored
  certificates, of anyone whose CloudTAK profile no longer exists (erased by an admin in
  CloudTAK, or by TAK Portal when it removes the user — requested in
  ValleyTacticalSolutions/TAK-Portal#132). A disabled profile keeps its links, closed.
- An expired certificate is not dialled; a linked server refusing the certificate (expired,
  revoked, untrusted) stops the link with the reason. Enroll again to fix.
- `Send selected` posts map-selected features to **one** of your linked servers, as you. The
  plugin never writes to the home TAK Server and never sends a position on its own.
- Known limitation (v1): CloudTAK's native Share / Broadcast / Share-to-Mission still go to
  the home server. A linked feature shared that way arrives there identifiable as linked
  (namespaced id, `metadata.crosstak`). The pane says so.

## Phase 2: a link works like an ATAK connection (PLAN §11)

- **They see you (W11).** While you are on the map, the web half sends your position (live
  GPS or the location you set) every 10 s to `POST /self`; CrossTAK sends it on each of your
  connected links as your TAK PLI (uid `ANDROID-CloudTAK-<username>`, callsign, team, role and
  phone from your CloudTAK profile, `takv` so TAK Server shows your team).
- **Send to a person, a team or a feed (W12).** `Send to…` on a link card lists the people on
  that server (`GET /server/:id/contact`). There is no broadcast: in TAK you send to a person, a
  team, or a Data Sync feed. A sent feature gets a fresh time and at least 24 h stale.
- **Native Share works too (W12b).** The web half wraps CloudTAK's `sendCOT` in the browser:
  a Share of one feature to a person seen through a link (uid `crosstak:<link>:<uid>`) goes out
  on that link instead of to the home server; home contacts and channels in the same Share go
  home as before. Not covered: multi-feature or attachment Shares (data packages) and chat.
- **Data Sync (W13).** `Data Sync` on a link card lists the feeds your account sees there.
  Join subscribes you (as `ANDROID-CloudTAK-<username>`) and loads the feed onto your map; change
  messages reload it live; Add selected (or `Send to… → Feed`) contributes to it if your role
  allows; Leave unsubscribes and clears its items. Password-protected feeds are not supported yet.
  Feeds live in `crosstak_mission` (the mission token is stored, never returned or logged).

## Linking a server

**By address (normal):** you enter the server's address (the name on its enrollment
certificate, e.g. `takserver.agency.org`) and your own username and password on it. CrossTAK enrolls
over port 8446, verified against a public CA (infra-TAK servers carry a Let's Encrypt
certificate there) or a CA you paste, and pins the CA chain the server hands back for its
8089 stream and 8443 API. The password is used for that one call and never stored.

**From certificates (advanced):** paste the CA chain, and optionally a client certificate and
unencrypted key. Without a client certificate, use Enroll afterwards.

`expected_name`: set it only when the server's 8089/8443 certificate does not name the host
you linked (infra-TAK TAK Servers present `DNS:takserver`). The status line shows the names
the certificate carries when this happens. The CA chain is still verified; the plugin accepts
the handshake only when the sole error is the name mismatch and the certificate matches
`expected_name`.

## Channels

Each linked server's card lists the channels (TAK Server groups) your account belongs to there,
and which are active. You can switch them; the choice is yours only (it is your account).
TAK Server 5.8 honours a switch only from a certificate issued with the channels extension
(OID 1.2.840.113549.1.9.7). The pane says when a linked identity's certificate lacks it. A
certificate made by hand with `makeCert.sh` lacks it. Link/Enroll certificates carried it on
every server tried so far (TAK Server 5.8).

## Routes (`/api/crosstak/*`, all authenticated, each user sees and changes only their own links)

| Route | Purpose |
|---|---|
| `GET /health` | version, ready flag, your own link count, whether you are seen on the map |
| `GET /server` | list your linked servers with live status. Never returns certificate bodies. |
| `POST /link` | link by `host` + `username`/`password`; optional `name`, `expected_name`, `ca` |
| `POST /server` | add from PEMs: `name`, `url` (`ssl://host:8089`), `ca` (required), optional `api`, `webtak`, `expected_name`, `cert`+`key`, `enabled` |
| `GET /server/:id`, `PATCH /server/:id`, `DELETE /server/:id` | read, update (changing url/ca/expected_name/cert restarts the stream), remove (closes the stream first) |
| `POST /server/:id/enroll` | replace the identity with a username/password enrollment |
| `GET /server/:id/channel`, `PUT /server/:id/channel` | list channels; set the active ones (`{active: [names]}`, at least one) |
| `GET /status` | your streams: connected/verified/since/last CoT/count/error, and whether you are seen on the map |
| `POST /send` | `{server_id, feature, to: {uids} \| {team} \| {mission}}` → one addressed CoT on that link (no broadcast); 503 while its stream is down |
| `POST /self` | your position (`longitude`, `latitude`, …) → your PLI on every connected link of yours |
| `GET /server/:id/contact` | people on that linked server, as your certificate sees them |
| `GET /server/:id/mission` | Data Sync feeds on that server your account can see, and which you joined |
| `PUT /server/:id/mission/:name`, `DELETE …`, `GET …` | join (subscribe and load), leave, list a joined feed's items |

## Layout

- `plugin/` — the CloudTAK web plugin (Vue 3 / TypeScript). Copied to `app/plugins/crosstak/`
  (CloudTAK ≥ 13.102; `api/web/plugins/` before that) and bundled by CloudTAK's Vite build.
- `server/plugin-crosstak.ts` — the CloudTAK API route. Copied to `api/stateless/routes/`
  (CloudTAK ≥ 13.45, the hub/api split). Owns the `crosstak_server` and `crosstak_mission`
  tables in CloudTAK's Postgres (`CREATE TABLE IF NOT EXISTS`).
- `install.sh` — standalone install for CloudTAK without TAK Portal.

The two halves land in two different places in the CloudTAK source tree, so CloudTAK's
`WEB_PLUGINS` env var cannot install this plugin. The TAK Portal CloudTAK marketplace does: its
catalog entry points at this repo with `web.source: plugin` and `routes.source: server`.

## Develop

The web half imports a few host modules relatively (`../../../src/std.ts`,
`../../../src/stores/map.ts`, `../../../plugin.ts`), so it only type-checks in place inside a
CloudTAK tree. The reliable pre-flight is the target CloudTAK's own API image: copy `plugin/` into
`/home/etl/app/plugins/crosstak/` and `server/plugin-crosstak.ts` into
`/home/etl/api/stateless/routes/` in a running `cloudtak-api` container, then run
`npx vue-tsc --noEmit -p tsconfig.json` in `app/` and `npx tsc --noEmit -p tsconfig.json` in
`api/`. Both must report zero errors for `crosstak` files before a rebuild.

```sh
cd plugin
npm install
npm run lint
```

`plugin/package.json` depends on `file:../../CloudTAK/api/web`, so this repo must be a sibling
of a CloudTAK checkout named `CloudTAK` (`file:../../CloudTAK/app` on 13.102+).

## License

AGPL-3.0-or-later — see `LICENSE`. Portions derived from dfpc-coe's MIT-licensed plugin
template keep their notice; see `NOTICE`.
