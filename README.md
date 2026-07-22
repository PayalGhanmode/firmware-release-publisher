# Firmware Release Publisher

## Overview

This project implements a firmware release publisher that handles signing and publishing of firmware release bundles after a code-signing key rotation.

The publisher:

- Reads and reconciles the firmware build manifest using DuckDB SQL.
- Removes duplicate records and withdrawn builds.
- Uses the currently active signing key for CMS detached signatures.
- Publishes signed release bundles to the distribution gateway.
- Maintains idempotency using request tokens and DuckDB persistence.
- Produces deterministic publication status output.

## Implementation

Main file:

```
environment/publisher/release-publisher.mjs
```

The publisher communicates with the provided distribution gateway:

```
GET  /v1/signing-key/current
POST /v1/publications
```

## Running

Inside the environment container:

```bash
npm install
npm run report
```

## Validation Output

The implementation was tested successfully with the provided Docker environment.

Command executed:

```bash
docker exec -it firmware-task bash

rm -f /app/releases.duckdb

npm run report
```

Successful output:

```
BUNDLE BND-101 SIGNED KEY=fw-signing-2026-current
BUNDLE BND-101 PUBLISHED RECEIPT=pub_8c2f19151394dd00a53cd0af TOKEN=token-BND-101 STATUS=PUBLISHED

BUNDLE BND-102 SIGNED KEY=fw-signing-2026-current
BUNDLE BND-102 PUBLISHED RECEIPT=pub_2e432f83848ee604d1be6484 TOKEN=token-BND-102 STATUS=PUBLISHED

BUNDLE BND-103 SIGNED KEY=fw-signing-2026-current
BUNDLE BND-103 PUBLISHED RECEIPT=pub_a85b26152614a1b2c985430c TOKEN=token-BND-103 STATUS=PUBLISHED
```

This confirms that:

- The rotated active signing key was used.
- CMS signatures were accepted by the gateway.
- Firmware bundles were successfully published.
- Idempotent publication tokens were recorded.
