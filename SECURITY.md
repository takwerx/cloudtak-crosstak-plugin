# Security

## Reporting a security problem

Do not report vulnerabilities, CVEs, exploits, leaked keys or passwords in
public issues, discussions or pull requests. Email **takwerx@gmail.com**
instead. Include what is affected, the version, and how to reproduce it. If you
have a fix, attach or describe it.

## Supported versions

Only the latest release gets security fixes. Update before reporting.

## What to expect

We reply within 3 working days, work with you privately until a fix ships, and
credit you if you want.

Please do not disclose it publicly until a fix is released.

## Scope

The web plugin in `plugin/`, the API route in `server/` and `install.sh`, including
authentication on the `/api/crosstak/` routes, the per-user isolation of links (one user must
never see or use another user's link), what is stored in CloudTAK's database (each user's
client certificates and keys for their linked servers, Data Sync tokens), and how certificates
are pinned on the linked servers' connections. Vulnerabilities in CloudTAK or TAK Server
themselves belong with those projects.
