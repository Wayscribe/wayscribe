import { describe, expect, it } from "vitest";
import { maskSecretsInText } from "./mask-text.js";

/**
 * Fake credentials, assembled from parts.
 *
 * Written whole, these are exactly what the repository's secret scanner exists
 * to find, and an allowance broad enough to cover them would hide a real one.
 * Concatenation keeps the shapes realistic without a literal to match.
 */
const fake = {
  stripeLive: "sk_" + "live_" + "4eC39HqLyjWDarjtT1zdp7dc",
  stripeTest: "sk_" + "test_" + "51Hx9aBcDeFgHiJkLmNoPqRs",
  stripeRestricted: "rk_" + "live_" + "Zx81Qw2Er3Ty4Ui5Op6As7Df",
  stripeWebhook: "whsec_" + "MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLc",
  slackBot: "xox" + "b-" + "2481357902-4872965130-uVq3MzRkT8sYpWnL0aBcDeFg",
  githubClassic: "gh" + "p_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
  githubApp: "gh" + "s_" + "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2",
  githubOauth: "gh" + "o_" + "Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6J7k8",
  githubFine: "github" + "_pat_" + "11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123",
  gitlab: "gl" + "pat-" + "xR7kP2mN9qL4wT6yB3vC",
  aws: "AK" + "IA" + "Q3EGUNLQ7XK4TWPM",
  google: "AI" + "za" + "SyD4xQ9mL2pK7wR3tV8nB5cF1hJ6gZ0aE_u",
  flightRecorder: "fr_" + "q8Zr4LmN2pXw7Kc9Vt3Hb6Js1Dy5Gf0A",
  jwt:
    "eyJ" +
    "hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" +
    ".eyJ" +
    "zdWIiOiIxMjM0NTY3ODkwIiwiaWF0IjoxNzU4MDAwMDAwfQ" +
    ".SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
  basic: "dXNlcj" + "pwYXNz",
  pemBody: "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun\nVTLw7onLRnrq0",
  opaque: "tok" + "_9f8e7d6c5b4a39281706",
  clientSecret: "cs-" + "Colon-Opaque-9"
};

const pemBegin = "-----BEGIN RSA " + "PRIVATE KEY-----";
const pemEnd = "-----END RSA " + "PRIVATE KEY-----";

interface Case {
  name: string;
  text: string;
  secrets: string[];
  /** Words around the secret that must still be readable afterwards. */
  keeps: string[];
}

/**
 * Error text as libraries actually produce it.
 *
 * Every case asserts both halves, as WHAT_RUNNING_IT_FOUND.md requires: the
 * secret is gone, and the text around it is not. A masker that returned an
 * empty string would pass the first half of every one of these.
 */
const positive: Case[] = [
  {
    name: "a pg connection string",
    text: "Connection terminated unexpectedly: postgres://app:hunter2-DB@db.internal:5432/app",
    secrets: ["hunter2-DB", "app:hunter2"],
    keeps: ["Connection terminated unexpectedly", "postgres://[REDACTED]@db.internal:5432/app"]
  },
  {
    name: "a password containing @ in a connection string",
    text: "connect ECONNREFUSED postgresql://svc:p@ss-W0rd@10.0.0.4:5432/orders",
    secrets: ["p@ss-W0rd", "svc:p"],
    keeps: ["connect ECONNREFUSED", "postgresql://[REDACTED]@10.0.0.4:5432/orders"]
  },
  {
    name: "a MongoDB SRV string",
    text: "MongoServerSelectionError: mongodb+srv://admin:S3cretMongo@cluster0.ab1cd.mongodb.net/?retryWrites=true",
    secrets: ["S3cretMongo"],
    keeps: ["MongoServerSelectionError", "cluster0.ab1cd.mongodb.net/?retryWrites=true"]
  },
  {
    name: "a Redis URL with only a password",
    text: "Redis connection to redis://:RedisPass99@cache:6379 failed - connect ETIMEDOUT",
    secrets: ["RedisPass99"],
    keeps: ["redis://[REDACTED]@cache:6379", "failed - connect ETIMEDOUT"]
  },
  {
    name: "an axios error echoing its request headers as JSON",
    text: `AxiosError: Request failed with status code 401 {"headers":{"Accept":"application/json","Authorization":"Bearer ${fake.opaque}"}}`,
    secrets: [fake.opaque],
    keeps: [
      "Request failed with status code 401",
      '"Accept":"application/json"',
      '"Authorization":"Bearer [REDACTED]"'
    ]
  },
  {
    name: "a header echo with a JWT",
    text: `Request failed: Authorization: Bearer ${fake.jwt} (GET /v1/me)`,
    secrets: [fake.jwt, "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"],
    keeps: ["Request failed: Authorization: Bearer [REDACTED]", "(GET /v1/me)"]
  },
  {
    name: "a bare JWT in prose",
    text: `jwt audience invalid for token ${fake.jwt}. expected: orders-api`,
    secrets: [fake.jwt],
    keeps: ["jwt audience invalid for token [REDACTED]", "expected: orders-api"]
  },
  {
    name: "Basic credentials",
    text: `upstream rejected Authorization: Basic ${fake.basic} with 403`,
    secrets: [fake.basic],
    keeps: ["Basic [REDACTED] with 403"]
  },
  {
    name: "a lowercase bearer header outside any assignment",
    text: `retrying with bearer ${fake.opaque} after 2s`,
    secrets: [fake.opaque],
    keeps: ["retrying with bearer [REDACTED] after 2s"]
  },
  {
    name: "a fetch URL with an access token in the query",
    text: `TypeError: fetch failed GET https://api.example.com/v1/items?access_token=${fake.opaque}&page=2`,
    secrets: [fake.opaque],
    keeps: ["TypeError: fetch failed", "?access_token=[REDACTED]&page=2"]
  },
  {
    name: "a camelCase secret name, normalised as path redaction does",
    text: `refresh failed: accessToken=${fake.opaque} refreshToken="rt-Opaque-77"`,
    secrets: [fake.opaque, "rt-Opaque-77"],
    keeps: ["refresh failed: accessToken=[REDACTED]", 'refreshToken="[REDACTED]"']
  },
  {
    name: "a Google key as the key query parameter",
    text: `The provided API key is invalid. https://maps.googleapis.com/maps/api/geocode/json?address=Raleigh&key=${fake.google}`,
    secrets: [fake.google],
    keeps: ["The provided API key is invalid.", "?address=Raleigh&key=[REDACTED]"]
  },
  {
    name: "a Stripe live key",
    text: `StripeAuthenticationError: Invalid API Key provided: ${fake.stripeLive}`,
    secrets: [fake.stripeLive],
    keeps: ["StripeAuthenticationError: Invalid API Key provided: [REDACTED]"]
  },
  {
    name: "a Stripe test key, a restricted key and a webhook secret",
    text: `keys ${fake.stripeTest}, ${fake.stripeRestricted} and ${fake.stripeWebhook} rejected`,
    secrets: [fake.stripeTest, fake.stripeRestricted, fake.stripeWebhook],
    keeps: ["keys [REDACTED], [REDACTED] and [REDACTED] rejected"]
  },
  {
    name: "an AWS SigV4 authorization echo",
    text: `SignatureDoesNotMatch: Credential=${fake.aws}/20260915/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7`,
    secrets: [fake.aws, "5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7"],
    keeps: [
      "SignatureDoesNotMatch: Credential=[REDACTED]/20260915/us-east-1/s3/aws4_request",
      "SignedHeaders=host;x-amz-date",
      "Signature=[REDACTED]"
    ]
  },
  {
    name: "a GitHub token in a clone URL",
    text: `fatal: Authentication failed for 'https://x-access-token:${fake.githubApp}@github.com/acme/orders.git/'`,
    secrets: [fake.githubApp],
    keeps: ["fatal: Authentication failed for 'https://[REDACTED]@github.com/acme/orders.git/'"]
  },
  {
    name: "GitHub classic, OAuth and fine-grained tokens",
    text: `HttpError: Bad credentials (${fake.githubClassic}; ${fake.githubOauth}; ${fake.githubFine})`,
    secrets: [fake.githubClassic, fake.githubOauth, fake.githubFine],
    keeps: ["HttpError: Bad credentials ([REDACTED]; [REDACTED]; [REDACTED])"]
  },
  {
    name: "a Slack bot token in a form body",
    text: `An API error occurred: invalid_auth (body: token=${fake.slackBot}&channel=C0123ABCD)`,
    secrets: [fake.slackBot],
    keeps: ["An API error occurred: invalid_auth", "token=[REDACTED]&channel=C0123ABCD"]
  },
  {
    name: "a GitLab token in a header echo",
    text: `401 Unauthorized PRIVATE-TOKEN: ${fake.gitlab} for GET /api/v4/projects`,
    secrets: [fake.gitlab],
    keeps: ["401 Unauthorized PRIVATE-TOKEN: [REDACTED] for GET /api/v4/projects"]
  },
  {
    name: "a Flight Recorder key",
    text: `ingest refused key ${fake.flightRecorder} for environment production`,
    secrets: [fake.flightRecorder],
    keeps: ["ingest refused key [REDACTED] for environment production"]
  },
  {
    name: "a PEM private key in a TLS error",
    text: `Error: error:1E08010C:DECODER routines::unsupported while loading\n${pemBegin}\n${fake.pemBody}\n${pemEnd}\n    at createSecureContext (node:internal/tls/secure-context:1:1)`,
    secrets: [fake.pemBody, "PRIVATE KEY"],
    keeps: ["DECODER routines::unsupported while loading\n[REDACTED]\n", "at createSecureContext"]
  },
  {
    name: "a PEM block cut off by truncation",
    text: `could not parse ${pemBegin}\n${fake.pemBody}`,
    secrets: [fake.pemBody],
    keeps: ["could not parse [REDACTED]"]
  },
  {
    name: "a JSON body with a quoted secret name",
    text: `422 Unprocessable Entity: {"username":"ops","api_key": "k-8812-opaque","region":"us"}`,
    secrets: ["k-8812-opaque"],
    keeps: ['"username":"ops"', '"api_key": "[REDACTED]"', '"region":"us"']
  },
  {
    name: "a JSON body escaped inside a JSON string",
    text: `body: "{\\"client_secret\\":\\"cs-Escaped-51\\",\\"grant_type\\":\\"client_credentials\\"}"`,
    secrets: ["cs-Escaped-51"],
    keeps: ['\\"client_secret\\":\\"[REDACTED]\\"', '\\"grant_type\\":\\"client_credentials\\"']
  },
  {
    name: "a password assignment",
    text: "login failed: password=hunter2-ASSIGN user=ops",
    secrets: ["hunter2-ASSIGN"],
    keeps: ["login failed: password=[REDACTED] user=ops"]
  },
  {
    name: "a secret named in a log line with a colon",
    text: `config invalid: client_secret: ${fake.clientSecret} (tenant acme)`,
    secrets: [fake.clientSecret],
    keeps: ["config invalid: client_secret: [REDACTED] (tenant acme)"]
  },
  {
    name: "a cookie header, to the end of its line",
    text: "request echo\nCookie: theme=dark; sid=s%3AOpaqueSession42\nHost: api.internal",
    secrets: ["OpaqueSession42"],
    keeps: ["request echo\nCookie: [REDACTED]\nHost: api.internal"]
  },
  {
    name: "a secret in a stack trace frame's message",
    text: `Error: upstream 401 for https://svc.internal/hook?sig=${"a1b2c3d4".repeat(4)}\n    at deliver (/app/dist/deliver.js:41:11)\n    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)`,
    secrets: ["a1b2c3d4a1b2"],
    keeps: [
      "upstream 401 for https://svc.internal/hook?sig=[REDACTED]",
      "at deliver (/app/dist/deliver.js:41:11)"
    ]
  }
];

/**
 * Text that must come back byte for byte.
 *
 * The identifiers here are why anybody opens the product. Masking a Salesforce
 * id or an order number would hide the thing a reader came to find, which is
 * the reason the masker recognises shapes and never guesses at entropy.
 */
const negative: { name: string; text: string }[] = [
  {
    name: "Salesforce ids",
    text: "Account 0018Z00002ABCdeQAF not found; parent 001Dn00000abcDEFIA2"
  },
  { name: "a UUID", text: "journey 3f2b8c1e-9a4d-4e6f-b1c2-7d8e9f0a1b2c already finished" },
  {
    name: "ISO timestamps",
    text: "event at 2026-09-15T12:34:56.789Z is older than 2026-09-14T00:00:00Z"
  },
  { name: "a SHA-256 digest", text: `content hash ${"9f86d081884c7d65".repeat(4)} differs` },
  { name: "a git commit", text: "deployed d473667 from main" },
  { name: "order numbers", text: "order ORD-2026-000123 (#100045678) failed to ship" },
  {
    name: "email addresses",
    text: "no customer with email jane.doe@example.com; tried mailto:jane@example.com"
  },
  {
    name: "a URL without userinfo",
    text: "GET https://api.example.com/v1/items?page=2&sort=desc returned 503"
  },
  { name: "a URL whose path holds @", text: "404 from https://registry.npmjs.org/@acme/sdk" },
  {
    name: "keyboard= and monkey=",
    text: "layout keyboard=us, monkey=banana, ?monkey=1&keyboard=2"
  },
  {
    name: "the word token in prose",
    text: "The security token included in the request is invalid."
  },
  { name: "token followed by a colon and prose", text: "Invalid token: expired" },
  { name: "a missing bearer token", text: "Missing Bearer token. Basic auth is not accepted." },
  { name: "password in prose", text: 'password authentication failed for user "app"' },
  { name: "a secret name with a plain word after a colon", text: "client_secret: missing" },
  { name: "key as a bare word", text: "cache key=customer:42 evicted; Missing key: customerId" },
  { name: "a name that only resembles a secret", text: "secretary=Jane passwords=3" },
  { name: "a secret name whose value is absent", text: 'validation failed: {"password": null}' },
  {
    name: "a stack trace",
    text: "TypeError: Cannot read properties of undefined (reading 'id')\n    at Object.<anonymous> (/app/src/index.js:10:5)\n    at Module._compile (node:internal/modules/cjs/loader:1554:14)"
  },
  { name: "a provider prefix without a token", text: "use an sk_live_ key, not a pk_live_ one" },
  { name: "the redaction marker itself", text: "[REDACTED]" },
  { name: "an empty string", text: "" }
];

describe("maskSecretsInText", () => {
  describe("masks credentials in real error text", () => {
    for (const testCase of positive) {
      it(testCase.name, () => {
        const masked = maskSecretsInText(testCase.text);
        for (const secret of testCase.secrets) expect(masked).not.toContain(secret);
        for (const kept of testCase.keeps) expect(masked).toContain(kept);
      });
    }
  });

  describe("leaves ordinary error text unchanged", () => {
    for (const testCase of negative) {
      it(testCase.name, () => {
        expect(maskSecretsInText(testCase.text)).toBe(testCase.text);
      });
    }
  });

  it("is idempotent: masking masked text changes nothing", () => {
    // The SDK masks before sending and the server masks again before storing,
    // so every SDK event passes through twice.
    for (const testCase of [...positive, ...negative]) {
      const once = maskSecretsInText(testCase.text);
      expect(maskSecretsInText(once), testCase.name).toBe(once);
    }
  });

  describe("runs in linear time", () => {
    // Error text is attacker-reachable: ingestion is public HTTP and the
    // protocol allows a 16 KiB stack. A pattern that backtracks quadratically
    // on near-matches would let one event hold the ingestion thread.
    const SIZE = 16 * 1024;
    const fill = (unit: string): string =>
      unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);

    const adversarial: Record<string, string> = {
      "JWT-like segments with no dot": fill("eyJa-"),
      "JWT-like segments with one dot": fill("eyJa.eyJb-"),
      "provider prefixes without bodies": fill("sk_live_x glpat-. xoxb-_ AKIA fr_"),
      "URL schemes with no @": fill("a://b:c:"),
      "a scheme then a long run with no @": "x://" + fill("a:"),
      "PEM headers with no key type": fill("-----BEGIN A "),
      "PEM headers with no end": fill(pemBegin + " "),
      "secret names with no separator": fill("password "),
      "secret names with plain-word values": fill("password: a "),
      "authorization schemes with no credential": fill("authorization: Bearer "),
      "unclosed quoted secret names": fill('"password'),
      "escaped quotes": fill('\\"a\\"'),
      "bearer words": fill("Bearer bearer "),
      "one long unbroken run": fill("a"),
      "a mixture": fill('eyJ-sk_live_ a://b:@ "api_key\\" Bearer -----BEGIN password=[ ')
    };

    for (const [name, text] of Object.entries(adversarial)) {
      it(`masks 16 KiB of ${name} in well under 50 ms`, () => {
        // Warm once so the measurement is the regex, not JIT compilation.
        maskSecretsInText(text.slice(0, 256));
        const started = performance.now();
        maskSecretsInText(text);
        expect(performance.now() - started).toBeLessThan(50);
      });
    }
  });
});
