# Research: which PII library for `loggercf/pii` (#10)

Issue #10, section 3, proposes an optional `loggercf/pii` entry point. It would adapt one PII-detection library to the upcoming `Redactor` interface (`{ value?(value, path), record?(record) }`) and declare that library as an optional peer dependency. This note picks the library, or argues against using one, from measurements rather than READMEs.

Researched 2026-11-14/15. Package versions are the latest on npm on that date.

## Recommendation

**Build a small built-in detector set in `loggercf/pii`, with no dependency. Do not adopt any of the evaluated libraries.**

- **Only one library is good enough at detection: `@claudiu-ceia/pii-mask`.** It is also far too slow for a per-line hot path on Workers.
  - A typical 1.4 KB record takes about 1.9 ms (p95 4.9 ms) in a quiet Node run. That is 20–50% of a Free request's 10 ms CPU, for one log line.
  - A 50 KB record takes about 270 ms. Some 20 KB adversarial strings take about 0.7 s.
  - Selecting fewer `kinds` does not help. The library runs all 12 parsers and filters afterwards.
  - It has one maintainer, 1 GitHub star and 8 downloads a week.
- **Every other candidate fails a hard requirement:**
  - OpenRedaction doesn't start on Workers.
  - Arcjet is async, which can't fit a synchronous log call. It also has no IBAN or token detection.
  - `@redactpii/node`, `@logtape/redaction` and `@visulima/redact` are missing required detectors. Visulima also redacts loggercf's own 32-hex trace IDs.
- **A built-in prototype matched or beat pii-mask on both corpora at 60–250× less CPU.** It is about 100 lines and 1.1 KB gzipped. It reached 100% recall on every type. Its only false positive was `10.15.30.12`, which is a valid IPv4 address anyway (see [Corpus results](#corpus-results)). It is linear on adversarial input.
- **The required detector set is small and well specified.** It is regex candidates plus deterministic validators: Luhn, IBAN mod-97, IPv6 parsing, and token prefixes. This is not where a dedicated library earns its keep. That would be NER-style detection of names, addresses and free-form IDs, and no candidate does that on Workers today.

This departs from the issue's principle that "real PII detection belongs to a dedicated library". The evidence says the dedicated libraries available today either don't run on Workers or cost one to two orders of magnitude more CPU, for the same detection on these types. The `Redactor` hook (section 1) stays the integration point, so an app can still plug in any library it chooses at its own CPU cost.

**If a dependency is still preferred:** `@claudiu-ceia/pii-mask` is the only acceptable choice. Use it only behind a hard per-string scan cap of 1–2 KB and a per-record byte budget, and pin the exact version (see [Risks](#risks)).

## Hard requirements: what the platform actually allows

Checked on 2026-11-14 against Cloudflare's docs:

| Limit                  | Value                                                                                                                           | Source                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Worker size            | **64 MiB uncompressed**, Free and Paid. "There is no compressed size limit. Only the uncompressed bundle size counts."          | https://developers.cloudflare.com/workers/platform/limits/ (Worker size)                     |
| CPU per HTTP request   | **10 ms on Free**. 30 s default on Paid, raisable to 5 min.                                                                     | same page (CPU time)                                                                         |
| Startup (global scope) | 1 s                                                                                                                             | same page (Worker startup time)                                                              |
| Memory                 | 128 MB per isolate, including Wasm allocations                                                                                  | same page (Memory)                                                                           |
| Code generation        | `eval()`, `new Function`, `WebAssembly.compile`/`compileStreaming`, and `WebAssembly.instantiate` with a buffer are not allowed | https://developers.cloudflare.com/workers/runtime-apis/web-standards/ (JavaScript standards) |

The issue's "3 MB compressed on Free / 10 MB on Paid" figures are out of date. Bundle size is no longer the binding constraint for any JS candidate here. The binding constraints are **CPU per line** (10 ms per request on Free, shared with the app's own work) and **synchronous execution**. loggercf's log calls are synchronous and must not throw or reorder lines, so an async detector can't run inside `Redactor.value` without buffering. Buffering would mean loggercf owning control flow.

The issue's suspicion about `fast-redact` holds. `fast-redact@3.5.0` builds its redactor with `Function('o', …)` (`lib/redactor.js:9`, also `restorer.js` and `validator.js`), so it is unusable on Workers. Its successor `@pinojs/redact@0.4.0` has no `Function`/`eval`. Both are key-path redactors, not PII detectors, which `redactKeys` (section 2) already covers.

## Candidates

The four from the issue, plus three alternatives found by searching npm for "pii redact", "pii detection" and "redact sensitive data logs". Downloads are for the week 2026-11-07 to 11-13. Stars, open counts and last commit come from the GitHub API.

|                                            | `@claudiu-ceia/pii-mask`                                                                | `@logtape/redaction`                            | `@openredaction/core`                                                                                                                                                                   | `@redactpii/node`                                                                            | `@arcjet/redact` (alt)                                                                               | `@visulima/redact` (alt)                                                     | `@stll/anonymize` (alt)                    |
| ------------------------------------------ | --------------------------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------ |
| Latest / date                              | 0.2.2 / 2026-09-20                                                                      | 2.4.2 / 2026-10-18                              | 1.1.5 / 2026-07-26                                                                                                                                                                      | 1.0.19 / 2026-09-28                                                                          | 1.15.0 / 2026-10-28                                                                                  | 5.0.0 / 2026-09-03                                                           | 3.0.7 / 2026-10-05                         |
| First published                            | 2026-07-25 (7 versions)                                                                 | 2025-05-18                                      | 2026-07-25                                                                                                                                                                              | 2025-11-08                                                                                   | 2024-09-02                                                                                           | 2024-05-12                                                                   | 2026-03-25                                 |
| Weekly downloads                           | **8**                                                                                   | 123,229                                         | 20,412                                                                                                                                                                                  | 86,960                                                                                       | 17,429                                                                                               | 19,537                                                                       | 51,685                                     |
| License                                    | MIT (deps MIT, `entities` BSD-2-Clause)                                                 | MIT                                             | MIT                                                                                                                                                                                     | MIT                                                                                          | Apache-2.0                                                                                           | MIT                                                                          | Apache-2.0                                 |
| npm maintainers                            | 1                                                                                       | 1                                               | 2                                                                                                                                                                                       | 1                                                                                            | 2 (Arcjet staff)                                                                                     | 1                                                                            | 1                                          |
| Repo stars / open issues+PRs               | 1 / 1                                                                                   | 2,035 / 12 (logtape monorepo)                   | 108 / 9                                                                                                                                                                                 | 6 / 0                                                                                        | 700 / 7 (arcjet-js monorepo)                                                                         | 58 / 11 (monorepo)                                                           | 11 / 31                                    |
| Last commit                                | 2026-09-20                                                                              | 2026-10-19                                      | 2026-11-12                                                                                                                                                                              | 2026-09-28                                                                                   | 2026-11-13                                                                                           | 2026-11-14                                                                   | 2026-11-09                                 |
| On npm / JSR                               | both                                                                                    | **both** (npm 2.4.2, JSR 2.4.2)                 | npm                                                                                                                                                                                     | npm                                                                                          | npm                                                                                                  | npm                                                                          | npm                                        |
| Runtime deps                               | `ts-duckling` pinned at 0.7.3, which pulls in `combine`, `@noble/hashes` and `entities` | peer `@logtape/logtape`, imported at module top | none (optional peers `mammoth`, `pdf-parse`, `tesseract.js`)                                                                                                                            | none                                                                                         | `@arcjet/redact-wasm`                                                                                | none (optional `compromise`)                                                 | `@stll/anonymize-data`, native napi binary |
| Sync API                                   | yes                                                                                     | yes (pattern objects)                           | **no** (`detect()` returns a Promise)                                                                                                                                                   | yes                                                                                          | **no** (`redact()` returns a Promise)                                                                | yes                                                                          | –                                          |
| Built-in detectors among the required ones | email, phone, card (Luhn), IBAN, IP, JWT, api_key (+ uuid, ssn, mac, bic, crypto)       | email, card, JWT (+ US SSN, KR RRN)             | all of them, among 581 patterns                                                                                                                                                         | email, US phone, card, SSN, names after a greeting                                           | email, phone, IP, card                                                                               | email, card, IP, some tokens, a generic 32-char "apikey", phone (US formats) | broad, dictionary-based                    |
| Workers: source audit                      | clean: no `eval`/`Function`, no `node:` imports, no `fetch`                             | clean (one `process.` hit is a JSDoc comment)   | **main**: top-level `fs`, `path`, `crypto`, `stream`, `node:os`, `node:worker_threads`, webhook `fetch`. **`/lite`**: `createRequire(import.meta.url)` from `node:module` at module top | clean. Its only `fetch` goes to `api.redactpii.com`, and only when an `apiKey` is configured | clean. A `workerd` export condition imports the `.wasm` modules. Instantiates Wasm **on every call** | clean                                                                        | `node:` imports in the default entry       |
| Workers: ran in workerd                    | **yes**                                                                                 | **yes**                                         | **no**: both entries fail at startup                                                                                                                                                    | **yes**                                                                                      | **yes**                                                                                              | **yes**                                                                      | not run (size)                             |
| Verdict                                    | detection OK, CPU and maintenance fail                                                  | detectors missing                               | doesn't run, async                                                                                                                                                                      | detectors missing                                                                            | async, detectors missing                                                                             | redacts trace IDs, detectors missing                                         | ruled out by size                          |

### Why `@stll/anonymize` was not benchmarked

The package is 58 MB unpacked and ships a native binary. Its Wasm build, `@stll/anonymize-wasm`, is 44 MB unpacked, and its own README says the default dictionary package alone is "~20 MB". That is probably the "Rust/WASM option" the issue says doesn't fit. Even under the current 64 MiB size limit, a dictionary that large against a 128 MB isolate and a 1 s startup budget is not reasonable for a logger add-on.

## Method

Everything ran in a scratch directory outside the repo. Packages were installed with `npm i --ignore-scripts` and their built code was read before running.

- **Source audit.** I grepped the shipped `.js`/`.mjs`/`.cjs` files (not `.d.ts`) of each package and its runtime deps for:
  - `eval(` and `new Function`;
  - `require('fs'|'net'|…)`, `from "node:…"` and `require("node:…")`;
  - `Buffer`, `process.`, `fetch(`, `XMLHttpRequest` and `WebSocket`.

  I then read each hit in context.

- **Bundle size.** I used the repo's toolchain (esbuild 0.28.2 from the main checkout's `node_modules`) with `platform: neutral`, `conditions: [workerd, worker, browser]`, `minify: true`, and a minimal entry that imports the one constructor or function an adapter needs and builds one instance. Sizes are gzip level 9. Wasm is reported separately.
- **Timing.** Node 24.22.1 on a Windows laptop. Each record is scanned by calling the library's string API on every string value: about the work `Redactor.value` would do. Medians come from 500 iterations for the typical record and 40 for the 50 KB record, after warmup. The cache is disabled where a library has one (`cacheSize: 0` / `enableCache: false`), because log lines are mostly unique and a cache would also retain PII.
  - Typical record: 18 strings, 1,435 chars. It has a message with an email and an IP, request headers including `traceparent` and `authorization`, a body with a phone number, a 7-frame error stack, `args`, and a prose note.
  - 50 KB record: the same, plus a 50,000-char JSON-like upstream body with one email at the end.
- **workerd.** I wrote scratch Workers and ran them under `wrangler dev` (wrangler 4.160.1, workerd 1.20261110.1, `compatibility_date` 2026-10-01) on port 18787, inspector 19229. I queried them with curl and then stopped them, including the workerd processes I had started.
  - Worker A (no `nodejs_compat`): pii-mask, the prototype, Arcjet (via its `workerd` condition and `CompiledWasm` rules), visulima, logtape and redactpii. It ran both corpora and returned results identical to Node.
  - OpenRedaction `/lite` and main: tried both pre-bundled with `--no-bundle` and bundled by wrangler itself, each with and without `nodejs_compat`. All four combinations fail at startup with `TypeError: The argument 'path' … Received 'undefined' at node:module … in createRequire`, because `import.meta.url` is undefined there.
  - workerd's `performance.now()` is coarse, so CPU timings are reported from Node only.
- **Detection.** Every case is tested twice: as a bare string value (what `Redactor.value` sees for a field) and embedded in a sentence (what it sees in `message`).
  - A case counts as **flagged** when the target no longer appears verbatim in the output. Partial redaction therefore counts as detection.
  - **Recall** = flagged positives / positives.
  - **Precision** = TP / (TP + FP), where FP counts the tricky negatives written for that type. For tokens, the trace-ID/UUID negatives count as the FPs.
  - With 8–16 cases per type, read the percentages as coarse signals, not benchmarks.

Each library was configured for the issue's detector set:

| Library       | Configuration                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------- |
| pii-mask      | `createPiiMasker({ mode: 'redact', kinds: ['email','phone','credit_card','iban','ip','jwt','api_key'], cacheSize: 0 })`   |
| logtape       | its `EMAIL_ADDRESS_PATTERN`, `CREDIT_CARD_NUMBER_PATTERN` and `JWT_PATTERN`, applied with `String.replace`                |
| OpenRedaction | `LiteOpenRedaction`, both with defaults (all 581 patterns) and with `patterns` limited to the 19 matching types           |
| redactpii     | `rules: { CREDIT_CARD, EMAIL, PHONE }`                                                                                    |
| Arcjet        | `entities: ['email', 'phone-number', 'ip-address', 'credit-card-number']`                                                 |
| visulima      | `[...credentialRules, ...piiRules]`, the subset its README recommends over the "intentionally aggressive" `standardRules` |

**A fairness note on OpenRedaction:** its email validator silently skips `@example.com`, `@test.com` and similar addresses unless the surrounding text looks like documentation. The corpus therefore uses realistic fictional domains such as `lovelace.dev` and `acme-corp.co.uk` rather than RFC 2606 ones.

### Corpus

**Main corpus**, 64 cases.

| Type                | Positives                                                                                                                                                           | Tricky negatives                                                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Email               | `ada@lovelace.dev`, `first.last+tag@mail.acme-corp.co.uk`, `müller@firma-gmbh.de`, `o_brien-99@eircom.ie`, `SUPPORT@CONTOSO.ORG`                                    | `hono@4.12.14`, `@types/node`, `user@localhost`                                                                                                                                                 |
| Phone               | `+44 20 7946 0958`, `+1 (415) 555-2671`, `+49 30 901820`, `+90 212 555 12 34`, `+33 1 23 45 67 89`, `+81 3-1234-5678`, `(555) 123-4567`                             | `2026-11-14`, `1731600000000`, `2026-11-14T20:40:40.014Z`, `20261114001`, `1234567 ns`                                                                                                          |
| Card (Luhn-valid)   | `4111 1111 1111 1111`, `5555555555554444`, `3782 822463 10005`, `6011-1111-1111-1117`, `4012888888881881`                                                           | Luhn-invalid: `4111 1111 1111 1112`, `5555555555554445`, `1234 5678 9012 3456`, `1731600000000123`                                                                                              |
| IBAN (mod-97-valid) | `GB82 WEST 1234 5698 7654 32`, `DE89370400440532013000`, `TR33 0006 1005 1978 6457 8413 26`, `FR1420041010050500013M02606`, `NL91ABNA0417164300`                    | bad checksum: `GB82WEST12345698765433`, `DE00370400440532013000`                                                                                                                                |
| IP                  | `192.168.1.20`, `8.8.8.8`, `203.0.113.195`, `1.1.1.1`, `2606:4700:4700::1111`, `2001:db8::1`, `fe80::1ff:fe23:4567:890a`, `2001:0db8:85a3:0000:0000:8a2e:0370:7334` | `999.300.1.1`, `v1.2.3`, `10:15:30`                                                                                                                                                             |
| Tokens              | a JWT, `ghp_` + 36, `AKIAIOSFODNN7EXAMPLE` (AWS's documented example key), `sk_live_` + 24, `xoxb-…`, `Bearer ` + 40 opaque chars, `npm_` + 36                      | see the next row                                                                                                                                                                                |
| Must survive        | –                                                                                                                                                                   | W3C trace-ids `4bf92f3577b34da6a3ce929d0e0e4736` and `a3f1c09be2d84c7f9e5b6d0a1c2e3f4b`, span-id `00f067aa0ba902b7`, a full `traceparent`, UUID v4, UUID v7, a 40-hex git SHA, a 64-hex SHA-256 |
| Benign log text     | –                                                                                                                                                                   | `GET /api/v1/users/42 200 in 12ms`, `retry 3 of 5 after 250 ms`, `loggercf/0.0.1 workerd`, `cache hit ratio 0.9831`                                                                             |

The token positives are fixed pseudo-random strings, abbreviated here.

**Held-out corpus**, 56 cases. I wrote it after the prototype existed and ran it once, with no tuning against it.

| Type         | Positives                                                                                                                                   | Tricky negatives                                                                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Email        | `j.doe@uni-heidelberg.de`, `x@y.io`, `name.surname@gmail.com`, `a.b-c_d@sub.domain.travel`, `josé.garcía@correo.es`                         | `pkg@latest`, `foo@bar`, `retry@3x`                                                                                                                                                                    |
| Phone        | `+7 495 123-45-67`, `+86 10 1234 5678`, `+61 2 9876 5432`, `+55 11 91234-5678`, `+1-800-555-0199`, `+353871234567`                          | `10.15.30.12`, `1.234.567,89`, `+0.25ms`, `3600000`                                                                                                                                                    |
| Card         | `4000056655665556`, `5200 8282 8282 8210`, `371449635398431`, `3056 9309 0259 04`, `6200000000000005`                                       | Luhn-invalid: `4000056655665557`, `5200 8282 8282 8211`, `1731600000124`                                                                                                                               |
| IBAN         | `ES91 2100 0418 4502 0005 1332`, `IT60X0542811101000000123456`, `CH9300762011623852957`, `BE68539007547034`, `PL61109010140000071219812874` | `ES91 … 1333` (bad checksum), `XX00 1234 5678 9012`                                                                                                                                                    |
| IP           | `172.16.254.1`, `100.64.0.1`, `::1`, `2a00:1450:4001:82a::200e`, `::ffff:192.0.2.128`                                                       | `1.2.3.4.5`, `300.1.2.3`, `12:34`                                                                                                                                                                      |
| Tokens       | an RS256 JWT, `github_pat_…`, `xoxp-…`, `sk_test_…`, `ASIA` + 16, `Bearer abc.def.ghi-opaque-token-1234567890`                              | –                                                                                                                                                                                                      |
| Must survive | –                                                                                                                                           | trace-id `0af7651916cd43dd8448eb211c80319c`, span-id `b7ad6b7169203331`, X-Ray `1-5759e988-bd862e3fe1be46a994272793`, cf-ray `8e2f1a3b4c5d6e7f-AMS`, a ULID, a Mongo ObjectId, an SRI hash `sha256-…=` |

`10.15.30.12` was meant as a phone negative, but it is a valid IPv4 address. Both libraries that flagged it flagged it _as an IP_, which is arguably correct. Treat that FP as a fixture ambiguity.

## Corpus results

Each cell is **recall % / precision %** per type. "–" means nothing was flagged, so precision is undefined. "Builtin-prototype" is the throwaway reference implementation [in the appendix](#appendix-built-in-prototype-throwaway).

### Main corpus

| Library                         | email     | phone     | card      | iban      | ip        | token     | trace/UUID flagged | benign flagged |
| ------------------------------- | --------- | --------- | --------- | --------- | --------- | --------- | ------------------ | -------------- |
| pii-mask                        | 100 / 100 | 100 / 100 | 100 / 100 | 100 / 100 | 100 / 100 | 71 / 100  | 0/16               | 0/8            |
| builtin-prototype               | 100 / 100 | 100 / 100 | 100 / 100 | 100 / 100 | 100 / 100 | 100 / 100 | 0/16               | 0/8            |
| openredaction-lite, 19 patterns | 100 / 83  | 36 / 83   | 100 / 100 | 50 / 100  | 50 / 100  | 100 / 100 | 0/16               | 0/8            |
| openredaction-lite, defaults    | 100 / 71  | 79 / 65   | 100 / 71  | 100 / 83  | 75 / 86   | 100 / 78  | 4/16               | 4/8            |
| arcjet-redact                   | 100 / 71  | 100 / 100 | 80 / 100  | 20 / 100  | 100 / 100 | 0 / –     | 0/16               | 0/8            |
| visulima-redact                 | 100 / 100 | 29 / 50   | 100 / 56  | 40 / 100  | 63 / 83   | 57 / 44   | **10/16**          | 0/8            |
| redactpii                       | 100 / 100 | 43 / 75   | 100 / 56  | 40 / 100  | 0 / –     | 0 / –     | 0/16               | 0/8            |
| logtape-redaction               | 100 / 83  | 0 / –     | 100 / 100 | 0 / –     | 0 / –     | 29 / 100  | 0/16               | 0/8            |

### Held-out corpus

| Library                         | email     | phone    | card      | iban      | ip        | token     | trace/UUID flagged |
| ------------------------------- | --------- | -------- | --------- | --------- | --------- | --------- | ------------------ |
| pii-mask                        | 100 / 100 | 100 / 86 | 100 / 100 | 100 / 100 | 100 / 83  | 83 / 100  | 0/14               |
| builtin-prototype               | 100 / 100 | 100 / 86 | 100 / 100 | 100 / 100 | 100 / 100 | 100 / 100 | 0/14               |
| openredaction-lite, 19 patterns | 100 / 100 | 25 / 100 | 80 / 100  | 50 / 100  | 60 / 75   | 67 / 100  | 0/14               |
| openredaction-lite, defaults    | 100 / 77  | 75 / 64  | 90 / 75   | 100 / 83  | 70 / 70   | 75 / 60   | 6/14               |
| arcjet-redact                   | 100 / 63  | 100 / 86 | 100 / 100 | 0 / –     | 100 / 100 | 0 / –     | 0/14               |
| visulima-redact                 | 100 / 100 | 50 / 75  | 100 / 63  | 20 / 50   | 60 / 60   | 50 / 75   | 2/14               |
| redactpii                       | 100 / 100 | 33 / 67  | 80 / 67   | 20 / 33   | 0 / –     | 33 / 100  | 0/14               |
| logtape-redaction               | 100 / 100 | 0 / –    | 100 / 100 | 0 / –     | 0 / –     | 17 / 100  | 0/14               |

workerd gave identical counts for every library in Worker A, run over both corpora together.

### What stands out

- **pii-mask** misses only opaque `Bearer …` values and `npm_` tokens. It never touches trace IDs or UUIDs, provided `uuid` is left out of `kinds`. Its only FPs are `1.2.3.4.5` → `[ip].5` and the ambiguous `10.15.30.12`.
- **OpenRedaction with defaults** is unusable for logs. Its Instagram-handle pattern rewrites ordinary words, so `request handled for … after upstream response` becomes `[IG_USER_0063] [IG_USER_2296] for … [IG_USER_0824] …`. It also tokenizes UUIDs and dates. Restricted to 19 patterns it is clean, but it misses most international phone formats, IBANs and IPs inside sentences, and `::1` and other compressed IPv6.
- **Arcjet** flags `hono@4.12.14` and `user@localhost` as emails, misses Mastercard `5555…4444`, and has no IBAN or token detector. Custom detection is possible only through a per-token JS callback.
- **visulima** has an `apikey` rule, `\b[a-zA-Z0-9]{32}\b`, which redacts every W3C trace-id, including the trace-id inside `traceparent`. It also redacts UUIDs (`<ID>`) and 40-hex git SHAs (`<AWSKEY>`). Its card rule has no Luhn check, so every invalid card is flagged.
- **redactpii** has no Luhn check and no IP or token detection. Its phone rule is US-only.
- **logtape** ships only email, card, JWT, US SSN and Korean RRN patterns.

## Bundle size

Minimal import, minified, then gzipped at level 9:

| Library                    | min (KB) | gzip (KB) | Wasm (KB raw / gzip) | Externals left unresolved                                                                                     |
| -------------------------- | -------- | --------- | -------------------- | ------------------------------------------------------------------------------------------------------------- |
| builtin-prototype          | 2.1      | **1.1**   | –                    | –                                                                                                             |
| `@redactpii/node`          | 5.0      | 2.0       | –                    | –                                                                                                             |
| `@visulima/redact`         | 6.1      | 2.0       | –                    | –                                                                                                             |
| `@arcjet/redact`           | 7.2      | 2.7       | 178.6 / 91.1         | –                                                                                                             |
| `@logtape/redaction`       | 23.3     | 6.4       | –                    | –                                                                                                             |
| `@openredaction/core/lite` | 216.7    | 55.4      | –                    | `node:module`                                                                                                 |
| `@claudiu-ceia/pii-mask`   | 124.2    | **56.7**  | –                    | –                                                                                                             |
| `@openredaction/core`      | 285.4    | 73.8      | –                    | `node:module`, `crypto`, `fs`, `fs/promises`, `path`, `stream`, `node:os`, `node:path`, `node:worker_threads` |

pii-mask's 124 KB minified is mostly code it doesn't need for these types:

- `ts-duckling`: 79.5 KB in total. That includes its URL parser (17.9 KB), `tlds.json` (15.7 KB), `languages-en.json` (10.7 KB) and its Time entity (6.9 KB).
- `entities`' HTML decode table: 23.4 KB.
- `@noble/hashes`: 9.6 KB.
- `combine`: 9.3 KB.
- pii-mask itself: only 2.4 KB.

None of these sizes is close to a Workers limit. They matter only for the acceptance criterion that a Worker importing `loggercf/pii` stays small.

## CPU cost

### Quiet run

All libraries back to back, on a quiet machine. The prototype row was measured before a ReDoS fix to its email detector ([Adversarial input](#adversarial-input)). The fixed version only appears in the loaded run below, where it is on par with redactpii, so the fix did not make it slower.

| Library                                           | typical 1.4 KB record: median / p95 (ms) | 50 KB record: median / p95 (ms) |
| ------------------------------------------------- | ---------------------------------------- | ------------------------------- |
| redactpii                                         | 0.024 / 0.033                            | 0.26 / 0.30                     |
| logtape-redaction                                 | 0.025 / 0.030                            | 0.32 / 0.38                     |
| builtin-prototype (before the fix)                | 0.032 / 0.040                            | 1.06 / 1.14                     |
| openredaction-lite, 19 patterns                   | 0.125 / 0.27                             | 0.70 / 1.13                     |
| visulima-redact                                   | 0.19 / 0.28                              | 3.65 / 4.48                     |
| arcjet-redact (async, Wasm instantiated per call) | 1.93 / 4.11                              | 10.6 / 12.6                     |
| **pii-mask**                                      | **1.94 / 4.90**                          | **267 / 316**                   |
| openredaction-lite, defaults                      | 3.25 / 3.77                              | 659 / 787                       |

### Loaded run

The machine became loaded partway through the session, and every library got 3–8× slower. I re-ran all of them back to back in the same conditions: two rounds, keeping the lower median. Use this table for the **ratios**:

| Library                                  | typical: median / p95 (ms) | 50 KB: median / p95 (ms) | typical, × prototype | 50 KB, × prototype |
| ---------------------------------------- | -------------------------- | ------------------------ | -------------------- | ------------------ |
| builtin-prototype (final, after the fix) | 0.061 / 0.12               | 1.47 / 1.87              | 1×                   | 1×                 |
| redactpii                                | 0.082 / 0.11               | 0.84 / 1.26              | 1.3×                 | 0.6×               |
| logtape-redaction                        | 0.092 / 0.17               | 1.18 / 1.78              | 1.5×                 | 0.8×               |
| openredaction-lite, 19 patterns          | 0.42 / 0.97                | 2.51 / 4.61              | 7×                   | 1.7×               |
| visulima-redact                          | 0.70 / 1.10                | 12.5 / 16.1              | 11×                  | 9×                 |
| arcjet-redact                            | 13.0 / 25.1                | 68.7 / 102               | 210×                 | 47×                |
| **pii-mask**                             | **15.6 / 33.4**            | **1,286 / 1,649**        | **255×**             | **875×**           |
| openredaction-lite, defaults             | 26.0 / 34.8                | 3,349 / 6,317            | 424×                 | 2,280×             |

The two runs agree on the ordering. The gap between pii-mask and the regex-based libraries is 60–250× on typical records and 250–900× on 50 KB records. On a quiet core, which is closer to a Workers isolate, use the first table's absolute numbers.

### Scaling with string length

Median ms for one string. JSON-like text, quiet run:

| Library                            | 1 KB     | 5 KB     | 10 KB    | 25 KB   | 50 KB   |
| ---------------------------------- | -------- | -------- | -------- | ------- | ------- |
| redactpii                          | 0.007    | 0.027    | 0.05     | 0.13    | 0.23    |
| openredaction-lite, 19 patterns    | 0.016    | 0.045    | 0.09     | 0.24    | 0.49    |
| builtin-prototype (before the fix) | 0.016    | 0.076    | 0.16     | 0.38    | 0.74    |
| visulima-redact                    | 0.08     | 0.33     | 0.71     | 1.68    | 3.29    |
| arcjet-redact                      | 0.27     | 0.87     | 1.56     | 3.68    | 7.15    |
| **pii-mask**                       | **3.06** | **21.5** | **39.5** | **135** | **261** |

On prose and stack-trace text pii-mask is about 2× cheaper, at roughly 130 ms per 50 KB. Its cost per character is roughly constant at about 2.5–5 µs, which is 100–300× the regex-based libraries.

### Why `kinds` does not help pii-mask

`selectedEntities` calls `findPii(input)`, which runs `Duckling(PIIParsers)` with all 12 parsers, and only then filters by kind (`dist/index.js`). Measured on 10 KB of JSON-like text:

| pii-mask setting                    | ms per 10 KB |
| ----------------------------------- | ------------ |
| `kinds: ['email']`                  | 38           |
| `kinds: ['api_key']`                | 61           |
| `kinds` set to the 7 required kinds | 52           |
| `kinds` unset (all)                 | 52           |

Calling `ts-duckling` directly with only the 7 required parsers brings that to 21.5 ms per 10 KB (2.3 ms per 1 KB). Each parser costs at least about 3.6 ms per 10 KB on its own, and the crypto-address parser costs 18.7 ms. Even this best case is about 2 µs per character.

### Adversarial input

These numbers are ms for one 20 KB string. They indicate ReDoS-style exposure.

| Input                  | pii-mask | prototype v1 | prototype after fix |
| ---------------------- | -------- | ------------ | ------------------- |
| `'a'*N + '@'`          | 12       | **765**      | 9                   |
| `'a@b' + '.c'*N + '!'` | **696**  | **771**      | 4                   |
| `'1 '*N`               | **633**  | 1            | 2                   |
| `'1-'*N`               | **538**  | **959**      | 2                   |
| `'+1 '*N`              | **703**  | 2            | 2                   |
| `'GB82 '*N`            | **347**  | 7            | 7                   |
| `'eyJa.'*N`            | **728**  | **1,457**    | 2                   |
| `'1.'*N`               | 164      | **1,608**    | 2                   |

Both pii-mask and the first prototype go superlinear on some inputs. In the prototype, the cause was the email regex retrying the local part from every start position. Replacing it with a scan that expands outward from each `@` made every adversarial input linear. In the back-to-back run, normal input costs no more than before.

pii-mask's blow-ups are inside its parser-combinator engine, so a loggercf adapter can only bound them by capping input length.

## Risks

### If loggercf builds the detector set (recommended)

- **Scope creep and false completeness.** Users will ask for names, addresses, national IDs and every country's phone formats. Keep the set closed and document it as "best-effort, format-based". Let apps add detectors with a `{ type, find(s) | re, validate? }` shape, or plug in a library through the `Redactor` hook.
- **Phone coverage is by design narrow.** The prototype only matches numbers written with a leading `+`, or in `(NNN) NNN-NNNN` form. National formats without `+`, such as `020 7946 0958` and `555-123-4567`, are not matched. This is deliberate: those formats overlap with order numbers, durations and dates. The same trade-off is behind pii-mask's 0 FPs on dates and epochs, and behind visulima's and redactpii's FPs.
- **ReDoS.** The first prototype went quadratic. CI must include an adversarial-input test with a per-string time bound. Every regex must have bounded quantifiers or be anchored by a lookbehind.
- **CPU on huge strings.** Even a linear detector costs about 1–3 ms per 50 KB. Run redaction **after** the #9 size limits, so the opt-in limits also bound the scan, and document that.
- **Hash replacement must be synchronous.** `crypto.subtle.digest` is async, so it can't be used in a sync log call. Options, none tested in workerd here:
  1. The app supplies `hash(value) => string`.
  2. With `nodejs_compat`, use `node:crypto` `createHmac`, which is synchronous.
  3. Ship a small JS HMAC-SHA-256.

  An _unkeyed_ hash of an email or phone number can be reversed by enumeration, so default to a keyed HMAC, or require a key for `hash` mode.

- **Maintenance.** Token prefixes change, such as GitHub's `github_pat_` and new Stripe key types. The set is small, but someone has to own it.

### If `@claudiu-ceia/pii-mask` is adopted anyway

- **CPU.** Expect about 2–3 ms per 1 KB of logged strings, and up to about 35 ms per 1 KB on adversarial input. A hard per-string scan cap of 1–2 KB (with a marker past the cap) and a per-record budget are mandatory. Even then, a single busy request on Free can spend most of its 10 ms in redaction.
- **Bus factor.** It has one maintainer, 1 star and 8 downloads a week, and it was first published in July 2026. It pins `ts-duckling` at exactly 0.7.3 (0.7.4 is out), and `ts-duckling` itself depends on `@noble/hashes` and `entities`. Pin exact versions and vendor-review upgrades.
- **Bundle.** It adds 57 KB gzipped, mostly unrelated Duckling entities.
- **API.** It is synchronous and its `replacement({ kind })` callback can implement censor, mask or hash, which is a good fit. Disable its LRU cache (`cacheSize: 0`): the README notes the cache retains the original strings.

### Rejected options, for the record

- **OpenRedaction:** it doesn't start on Workers, and its API is async.
- **Arcjet:** async, re-instantiates Wasm on every call, and has no IBAN or token detector.
- **visulima:** it redacts trace IDs and UUIDs.
- **redactpii and logtape:** both lack required detectors.
- **`@stll/anonymize`:** too large.
- **`fast-redact`:** uses `Function()`.

## Appendix: built-in prototype (throwaway)

This is the code measured above, given as evidence and as a starting point. It is not production-ready: there are no options, no caps and no tests. The email scanner is the post-fix version.

<details><summary>builtin.mjs (about 100 lines)</summary>

```js
const luhn = (d) => {
  let sum = 0
  for (let i = 0; i < d.length; i++) {
    let n = d.charCodeAt(d.length - 1 - i) - 48
    if (i & 1) n = n * 2 > 9 ? n * 2 - 9 : n * 2
    sum += n
  }
  return sum % 10 === 0
}
const mod97 = (s) => {
  const x = s.slice(4) + s.slice(0, 4)
  let r = 0
  for (let i = 0; i < x.length; i++) {
    const c = x.charCodeAt(i)
    const v = c >= 65 ? c - 55 : c - 48
    r = v > 9 ? (r * 100 + v) % 97 : (r * 10 + v) % 97
  }
  return r === 1
}
const ipv6 = (s) => {
  const dbl = s.split('::')
  if (dbl.length > 2) return false
  const groups = dbl.flatMap((p) => (p === '' ? [] : p.split(':')))
  if (!groups.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return false
  return dbl.length === 2 ? groups.length < 8 : groups.length === 8
}

export const detectors = {
  // Scans outward from each '@' (linear, no regex backtracking over the local part).
  email: {
    scan(s, replace) {
      let at = s.indexOf('@')
      if (at < 0) return s
      const local = /[\p{L}\p{N}._%+'-]/u
      const dom = /[\p{L}\p{N}.-]/u
      let out = ''
      let last = 0
      while (at >= 0) {
        let a = at
        while (a > last && at - a < 64 && local.test(s[a - 1])) a--
        let b = at + 1
        while (b < s.length && b - at < 254 && dom.test(s[b])) b++
        while (b > at + 1 && (s[b - 1] === '.' || s[b - 1] === '-')) b--
        const domain = s.slice(at + 1, b)
        const tld = domain.slice(domain.lastIndexOf('.') + 1)
        if (a < at && domain.includes('.') && !domain.includes('..') && /^\p{L}{2,}$/u.test(tld)) {
          out += s.slice(last, a) + replace('email', s.slice(a, b))
          last = b
        }
        at = s.indexOf('@', Math.max(at + 1, last))
      }
      return out + s.slice(last)
    },
  },
  phone: {
    re: /(?<![\w+])(?:\+\d{1,3}[ .-]?(?:\(\d{1,4}\)[ .-]?)?\d{1,4}(?:[ .-]?\d{1,4}){1,5}|\(\d{3}\) ?\d{3}[ .-]\d{4})(?!\w)/g,
    ok: (m) => {
      const n = m.replace(/\D/g, '').length
      return n >= 8 && n <= 15
    },
  },
  card: {
    re: /(?<![\d-])[3-6]\d{3}(?:[ -]?\d){9,15}(?![\d-])/g,
    ok: (m) => {
      const d = m.replace(/\D/g, '')
      return d.length >= 13 && d.length <= 19 && luhn(d)
    },
  },
  iban: {
    re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g,
    ok: (m) => mod97(m.replace(/ /g, '')),
  },
  ip: {
    re: /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\d.])|(?<![\w:])[0-9a-fA-F]{0,4}(?::[0-9a-fA-F]{0,4}){2,7}(?![\w:])/g,
    ok: (m) => m.includes('.') || ((m.includes('::') || m.split(':').length === 8) && ipv6(m)),
  },
  token: {
    re: /\beyJ[\w-]{4,}\.eyJ[\w-]{4,}\.[\w-]{8,}|\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_\w{22,}|xox[abprs]-[\w-]{10,}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|(?:AKIA|ASIA)[0-9A-Z]{16}|npm_[A-Za-z0-9]{36})\b|(?<=\bBearer\s+)[\w.~+/-]{16,}=*/g,
  },
}

export function createDetector(types = Object.keys(detectors), replace = (type) => `[${type}]`) {
  const active = types.map((t) => [t, detectors[t]])
  return (s) => {
    for (const [type, d] of active) {
      if (d.scan) {
        s = d.scan(s, replace)
        continue
      }
      d.re.lastIndex = 0
      if (!d.re.test(s)) continue
      d.re.lastIndex = 0
      s = s.replace(d.re, (m) => (d.ok && !d.ok(m) ? m : replace(type, m)))
    }
    return s
  }
}
```

</details>

In the measurements it ran in the order `token, email, iban, card, phone, ip`. Tokens and IBANs go before cards, so their digit runs are not claimed as card numbers first.

**This prototype was written by the same person who wrote the main corpus.** Its main-corpus score is therefore overfit by construction. The held-out corpus, written afterwards and not tuned against, is the fairer comparison. There, its results match pii-mask on every type except IP and token, where it scores higher.
