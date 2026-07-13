# Architecture Decision Records

Short records of decisions made building the `drop` relay, written for future-us —
someone (possibly present-us, six months from now) who needs to know *why* something
is shaped the way it is before changing it. Lightweight format: Context, Decision,
Consequences. Not a full MADR template; this is a personal-scale project.

1. [Metadata surface area is acceptable](0001-metadata-surface-area.md)
2. [Auth codes: DB-backed, checked at call time, not cached](0002-auth-codes-no-cache.md)
3. [Skills over hooks for triggering a push](0003-skills-over-hooks.md)
4. [Client-side crypto ported from Ei](0004-crypto-ported-from-ei.md)
5. [Multi-item inbox, not single-slot overwrite](0005-multi-item-inbox.md)
6. [Git diff/patch, not git bundle, as the artifact format](0006-diff-not-bundle.md)
7. [TTL expiry is lazy + probabilistic, not cron](0007-ttl-without-cron.md)
8. [Isolated SFTP account + database per app](0008-isolated-infra-per-app.md)
9. [Docker for local PHP tooling, not a host install](0009-docker-for-local-php.md)
10. [Byte-native envelope, generalized artifact shape, `--install`](0010-byte-native-envelope-and-input-flow.md)
11. [Static deprecated-skill list, never dynamic diffing, for install cleanup](0011-static-deprecated-skill-list.md)
12. [Single invocation mechanism: `bunx drop-f`, no curl'd-down standalone mode](0012-single-invocation-mechanism.md)
