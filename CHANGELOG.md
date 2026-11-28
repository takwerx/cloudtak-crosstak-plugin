# Changelog

## Unreleased

- **Runtime bundle (CloudTAK 14.2 and later).** `bundle/` builds CrossTAK as one uploadable
  bundle, so it can also load on the iPhone and Android CloudTAK apps. It does nothing when the
  compiled-in CrossTAK is there, and says so plainly when the server part does not match. The
  Marketplace source install is unchanged.

## 0.6.1

- **Light and dark mode.** The CrossTAK menu icon now follows CloudTAK's theme, so it no longer
  disappears on the dark panel. The close buttons on alert messages are readable in the light
  theme.
- **Clearer certificate name message.** If a linked server's certificate names something other
  than the address you typed (infra-TAK servers name `takserver`), the server card now says so.
  It tells you to click Edit on that server and which name to type in "Expected certificate
  name". The certificate authority is still checked.

## 0.6.0 (first public release)

CrossTAK shows other agencies' TAK Servers on your CloudTAK map. Each user links the servers
they already have an account on, so they work in one CloudTAK instead of one per agency.
Linked servers are separate, directly enrolled connections, not federation.

- **Per user.** Every link belongs to the person who made it, with their own certificate on
  that server. Nobody else sees the link or its data.
- **Link by address.** Enter the server's address and your username and password there.
  CrossTAK enrolls over port 8446, pins the server's CA for its streaming and API ports, and
  never stores the password. Linking from certificate files is also possible.
- **Live picture.** The linked server's CoT for your channels arrives on your map. Choose your
  channels there from the pane.
- **They see you.** Your position goes to each of your linked servers as your normal TAK
  position report (callsign, team, role).
- **Send to a person, a team or a Data Sync feed** on a linked server. CloudTAK's own Share to
  a person seen through a link also goes out over the link.
- **Data Sync.** Join and leave feeds on a linked server, see their items, and add to them.
- **Clean failure.** An expired or refused certificate stops the link with the reason; enroll
  again to fix it. When a CloudTAK user is erased, their links and stored certificates go too.

Known limits: CloudTAK's own Share of several features or of attachments, and chat, still go
to the home server only. Password-protected feeds are not supported yet. CloudTAK's native
Share / Broadcast / mission actions on a linked feature copy it to the home server (marked as
linked).
