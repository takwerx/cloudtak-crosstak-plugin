# CrossTAK as a CloudTAK runtime plugin

CloudTAK 14.2 and later can load a plugin from an uploaded bundle instead of compiling it into the
web build. Users who choose it in **Settings → Plugins** get it on the web, and on the iPhone and
Android apps, which have no compiled-in plugins. This folder builds that bundle. It does not
replace the source install the TAK Portal Marketplace does; both can be on one CloudTAK.

## Build

```
node bundle/build.mjs --cloudtak /path/to/CloudTAK      # writes bundle/dist/crosstak-<version>.tar.gz
node bundle/check.mjs --cloudtak /path/to/CloudTAK      # vue-tsc and eslint against that CloudTAK
CLOUDTAK_APP=/path/to/CloudTAK node --test test/*.test.mjs
```

The CloudTAK checkout only supplies tools (Vite, the Vue compiler, the icon set). The version is the
one in `server/plugin-crosstak.ts`: the bundle and the server part are one release.

## Upload (an admin, once per version)

`POST /api/plugin/bundle` with the `.tar.gz`, then enable it (`PATCH /api/plugin/:id`). A non-admin
gets 401 for upload, enable and delete. The server part (`server/plugin-crosstak.ts`) must be
installed first; the Marketplace does that.

## How it differs from `plugin/`

- Own menu key `crosstak-runtime` and route `home-menu-plugin-crosstak-runtime`.
- If the compiled-in CrossTAK is there, the bundle does nothing, so the menu shows CrossTAK once.
- It asks `GET /api/crosstak/health` first. If the server part is missing or a different
  major.minor, the page says so in plain words and no position report or Share change is made.
- A bundle can only import `vue`, `vue-router` and `@tak-ps/vue-tabler` from the host. CloudTAK's
  `std()`, map store and menu frame are replaced by `bundle/shims/`. The map store is found through
  the Pinia instance the plugin API carries (`pinia._s`, an internal). If a later CloudTAK renames
  it, the page says CrossTAK cannot reach the map.
- The panes are the same files as `plugin/lib/`, so a fix there reaches both. `bundle/entry.ts`
  repeats the small plugin class of `plugin/index.ts`: change both together.
