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
  clientSecret: "cs-" + "Colon-Opaque-9",
  openaiProject: "sk-" + "proj-" + "Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56",
  openaiLegacy: "sk-" + "Qr78St90Uv12Wx34Yz56Ab78Cd90Ef12Gh34Ij56Kl78Mn90",
  anthropic: "sk-" + "ant-api03-" + "Zy98Xw76Vu54Ts32Rq10Po98Nm76Lk54Ji32",
  npm: "npm_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
  sendgrid: "SG." + "Ab12Cd34Ef56Gh78Ij90Kl" + "." + "Mn34Op56Qr78St90Uv12Wx34Yz56Ab78Cd90Ef12Gh3",
  slackApp: "xapp-" + "1-A0123456789-0123456789012-abcdef0123",
  huggingFace: "hf_" + "Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr",
  slackHookPath: "abcd" + "EFGH1234" + "ijklMNOP" + "5678",
  discordHookPath: "AbCdEf" + "-GhIjKl_" + "MnOpQr12" + "34567890",
  pgpBody: "lQOYBGVxY2UBCADFq8Zt3r9pQ0mN7vK2sL4wX6yB1cD5eF8gH0jI3kM9nO2pR4tU"
};

const pemBegin = "-----BEGIN RSA " + "PRIVATE KEY-----";
const pemEnd = "-----END RSA " + "PRIVATE KEY-----";
const pgpBegin = "-----BEGIN PGP " + "PRIVATE KEY BLOCK-----";
const pgpEnd = "-----END PGP " + "PRIVATE KEY BLOCK-----";

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
  },
  {
    name: "a Bearer credential of letters and digits",
    text: "upstream said Bearer abc123def456 is revoked",
    secrets: ["abc123def456"],
    keeps: ["upstream said Bearer [REDACTED] is revoked"]
  },
  {
    name: "a cookie line with a session id",
    text: "cookie: sid=abc123; path=/",
    secrets: ["abc123"],
    keeps: ["cookie: [REDACTED]"]
  },
  {
    name: "a header-form secret name echoed with a value",
    text: `x-auth-token: ${fake.opaque} for GET /v1/orders`,
    secrets: [fake.opaque],
    keeps: ["x-auth-token: [REDACTED] for GET /v1/orders"]
  },
  {
    name: "a GitLab private token header with an opaque value",
    text: `PRIVATE-TOKEN: ${fake.clientSecret}`,
    secrets: [fake.clientSecret],
    keeps: ["PRIVATE-TOKEN: [REDACTED]"]
  },
  {
    name: "OpenAI project and legacy keys and an Anthropic key",
    text: `401 Incorrect API key provided: ${fake.openaiProject}; also tried ${fake.openaiLegacy} and ${fake.anthropic}`,
    secrets: [fake.openaiProject, fake.openaiLegacy, fake.anthropic],
    keeps: ["401 Incorrect API key provided: [REDACTED]; also tried [REDACTED] and [REDACTED]"]
  },
  {
    name: "an npm token",
    text: `npm ERR! 401 Unauthorized with ${fake.npm} - PUT https://registry.npmjs.org/@acme%2fsdk`,
    secrets: [fake.npm],
    keeps: [
      "npm ERR! 401 Unauthorized with [REDACTED] - PUT https://registry.npmjs.org/@acme%2fsdk"
    ]
  },
  {
    name: "a SendGrid key, a Slack app token and a Hugging Face token",
    text: `rejected: ${fake.sendgrid}, ${fake.slackApp}, ${fake.huggingFace}`,
    secrets: [fake.sendgrid, fake.slackApp, fake.huggingFace],
    keeps: ["rejected: [REDACTED], [REDACTED], [REDACTED]"]
  },
  {
    name: "a Slack incoming webhook URL",
    text: `POST https://hooks.slack.com/services/T0123ABCD/B0456EFGH/${fake.slackHookPath} returned 404`,
    secrets: [fake.slackHookPath],
    keeps: ["POST https://hooks.slack.com/services/T0123ABCD/B0456EFGH/[REDACTED] returned 404"]
  },
  {
    name: "a Discord webhook URL",
    text: `webhook https://discord.com/api/webhooks/123456789012345678/${fake.discordHookPath} failed`,
    secrets: [fake.discordHookPath],
    keeps: ["webhook https://discord.com/api/webhooks/123456789012345678/[REDACTED] failed"]
  },
  {
    name: "a PGP private key block",
    text: `gpg import failed:\n${pgpBegin}\n\n${fake.pgpBody}\n${pgpEnd}\ncontinuing`,
    secrets: [fake.pgpBody, "PRIVATE KEY BLOCK"],
    keeps: ["gpg import failed:\n[REDACTED]\ncontinuing"]
  }
];

/**
 * Names split into words, and the words decide.
 *
 * Environment variables and configuration keys name a secret with a qualifier
 * in front of it, `DB_PASSWORD` or `STRIPE_API_KEY`, which exact matching
 * missed. The kept list is the other half: names that end near a secret word,
 * or start with one, and hold identifiers, counts and settings.
 */
const maskedNames = [
  "DB_PASSWORD",
  "POSTGRES_PASSWORD",
  "MYSQL_ROOT_PASSWORD",
  "redisPassword",
  "AWS_SECRET_ACCESS_KEY",
  "JWT_SECRET",
  "SESSION_SECRET",
  "WEBHOOK_SECRET",
  "GITHUB_TOKEN",
  "NPM_TOKEN",
  "X-Amz-Security-Token",
  "aws_session_token",
  "sessionToken",
  "idToken",
  "authToken",
  "private_token",
  "PRIVATE-TOKEN",
  "x-auth-token",
  "secretKey",
  "privateKey",
  "AccountKey",
  "STRIPE_API_KEY",
  "OPENAI_API_KEY",
  "stripe_signing_key",
  "KEY_PASSPHRASE",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "passwd",
  "pwd",
  "pass"
];

const keptNames = [
  "secretary",
  "SECRETARY_NAME",
  "undersecretary",
  "passwordless",
  "PASSWORDLESS_ENABLED",
  "password_reset_url",
  "password_hash",
  "passwordPolicy",
  "token_count",
  "max_tokens",
  "TOKEN_EXPIRY",
  "tokenizer",
  "pageToken",
  "nextPageToken",
  "nextToken",
  "continuationToken",
  "csrf_token",
  "idempotency_key",
  "IdempotencyKey",
  "primaryKey",
  "cache_key",
  "sortKey",
  "partitionKey",
  "publicKey",
  "SecretId",
  "secret_arn",
  "AWS_ACCESS_KEY_ID",
  "api_key_name",
  "secretName",
  "tokenType",
  "token_type",
  "keyring",
  "keyboard",
  "monkey"
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
  { name: "an empty string", text: "" },
  {
    name: "a WWW-Authenticate challenge's auth-params",
    text: 'WWW-Authenticate: Bearer realm="api", error="invalid_token"'
  },
  { name: "Basic before a short product term", text: "Basic 3DS verification failed" },
  { name: "basic before a hyphenated plan name", text: "basic plan-2026 quota exceeded" },
  { name: "bearer before a version", text: "bearer v2 token expired" },
  {
    name: "a URL followed by a comma and an email address",
    text: "sites https://example.com,jane@example.com rejected"
  },
  {
    name: "a URL followed by a semicolon and an email address",
    text: "url=http://cdn.example.com;owner=jane@example.com"
  },
  {
    name: "a secret-named segment inside an ARN, with no blank after the colon",
    text: "SecretId: arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/db-AbCdEf"
  },
  { name: "a cookie line that is a sentence", text: "cookie: session expired; please sign in" },
  { name: "an env-style secret name followed by prose", text: "DB_PASSWORD: not set" },
  { name: "a header-form secret name followed by prose", text: "x-auth-token: missing" },
  { name: "an sk- package name", text: "import sk-learn failed; npm_config_registry unset" },
  { name: "an hf_ function name", text: "hf_hub_download raised HfHubHTTPError" },
  {
    name: "a Discord channel link",
    text: "see https://discord.com/channels/123456789012345678/42"
  },
  {
    name: "a PGP public key block",
    text: "-----BEGIN PGP PUBLIC KEY BLOCK-----\nmQENBGVxY2UBCAD\n-----END PGP PUBLIC KEY BLOCK-----"
  }
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

  describe("reads a secret name by its words", () => {
    const value = "Opaque" + "-Value-" + "42x9";

    for (const name of maskedNames) {
      it(`masks ${name}= and "${name}":`, () => {
        expect(maskSecretsInText(`failed with ${name}=${value} set`)).toBe(
          `failed with ${name}=[REDACTED] set`
        );
        expect(maskSecretsInText(`{"${name}": "${value}", "region": "us"}`)).toBe(
          `{"${name}": "[REDACTED]", "region": "us"}`
        );
      });
    }

    for (const name of keptNames) {
      it(`keeps ${name}= and "${name}":`, () => {
        const assigned = `failed with ${name}=${value} set`;
        const quoted = `{"${name}": "${value}", "region": "us"}`;
        expect(maskSecretsInText(assigned)).toBe(assigned);
        expect(maskSecretsInText(quoted)).toBe(quoted);
      });
    }

    it("reads an unquoted colon as a value only when a blank follows it", () => {
      // `secret:prod/db` inside an ARN is a path segment, not an assignment.
      expect(maskSecretsInText(`x-auth-token:${value}`)).toBe(`x-auth-token:${value}`);
      expect(maskSecretsInText(`x-auth-token: ${value}`)).toBe("x-auth-token: [REDACTED]");
    });
  });

  it("is idempotent: masking masked text changes nothing", () => {
    // The SDK masks before sending and the server masks again before storing,
    // so every SDK event passes through twice.
    for (const testCase of [...positive, ...negative]) {
      const once = maskSecretsInText(testCase.text);
      expect(maskSecretsInText(once), testCase.name).toBe(once);
    }
  });

  it("is idempotent on the inputs generation found", () => {
    // One of each class, kept by name so a regression reads as what it is.
    const found = [
      // A later rule removed the `/` that ended a URL userinfo span.
      "token://password://.@",
      "x://password=.tokena://xax://19=1@.1x",
      // A marker's `]` let a quoted name start where the original letter had not.
      'token=a"password"://.91tokenZpassword Bearer a password',
      // A skipped scheme match consumed the scheme word after it.
      " @Bearer password9=Bearer Bearer passwordx9=@"
    ];
    for (const text of found) {
      const once = maskSecretsInText(text);
      expect(maskSecretsInText(once), text).toBe(once);
    }
  });

  describe("is idempotent on generated text built from the pieces its rules react to", () => {
    // The corpus above is text somebody thought of. `token://password://.@` was
    // not: the URL rule masked it into something the assignment rule then
    // matched, so the server's second pass changed what the SDK had sent.
    // Seeded, so a failure reproduces; the first few failing inputs are the
    // assertion's message.
    for (const [name, pieces] of Object.entries(GENERATOR_ALPHABETS)) {
      it(`from ${name}`, () => {
        const random = seeded(0x5eed);
        const failures: string[] = [];
        for (let run = 0; run < 20_000; run += 1) {
          const text = generate(random, pieces, 40);
          const once = maskSecretsInText(text);
          if (maskSecretsInText(once) !== once) failures.push(text);
        }
        expect(failures.slice(0, 5)).toEqual([]);
      });
    }
  });

  describe("scales linearly with its input", () => {
    // Error text is attacker-reachable: ingestion is public HTTP and the
    // protocol allows a 16 KiB stack. A pattern that backtracks quadratically
    // on near-matches would let one event hold the ingestion thread.
    //
    // Each case is timed at 16 KiB and at 64 KiB. Linear work takes about four
    // times as long at four times the size; quadratic work takes sixteen. A
    // wall-clock limit alone passed a callback that was quadratic on a run of
    // dots, because 16 KiB of it still fit under the limit on a fast machine.
    const KIB = 1024;
    const fill = (unit: string, size: number): string =>
      unit.repeat(Math.ceil(size / unit.length)).slice(0, size);

    /** The fastest of several runs, which is the least noisy estimate of the work. */
    const fastest = (text: string): number => {
      let best = Number.POSITIVE_INFINITY;
      for (let run = 0; run < 5; run += 1) {
        const started = performance.now();
        maskSecretsInText(text);
        best = Math.min(best, performance.now() - started);
      }
      return best;
    };

    /** Below this, a difference is scheduler and collector noise, not complexity. */
    const NOISE_FLOOR_MS = 10;

    const adversarial: Record<string, (size: number) => string> = {
      "JWT-like segments with no dot": (size) => fill("eyJa-", size),
      "JWT-like segments with one dot": (size) => fill("eyJa.eyJb-", size),
      "provider prefixes without bodies": (size) => fill("sk_live_x glpat-. xoxb-_ AKIA fr_", size),
      "URL schemes with no @": (size) => fill("a://b:c:", size),
      "a scheme then a long run with no @": (size) => "x://" + fill("a:", size),
      "PEM headers with no key type": (size) => fill("-----BEGIN A ", size),
      "PEM headers with no end": (size) => fill(pemBegin + " ", size),
      "secret names with no separator": (size) => fill("password ", size),
      "secret names with plain-word values": (size) => fill("password: a ", size),
      "authorization schemes with no credential": (size) => fill("authorization: Bearer ", size),
      "unclosed quoted secret names": (size) => fill('"password', size),
      "escaped quotes": (size) => fill('\\"a\\"', size),
      "bearer words": (size) => fill("Bearer bearer ", size),
      "Bearer and a run of dots": (size) => "Bearer " + ".".repeat(size) + "a",
      "Basic and a run of dots": (size) => "Basic " + ".".repeat(size) + "a",
      "Bearer and a long hyphenated run": (size) => "Bearer " + fill("ab-", size),
      "Bearer and a long auth-param name": (size) => "Bearer " + fill("a", size) + "=",
      "a name that is one long run of capitals": (size) => fill("A", size) + "=value1",
      "a name of many camelCase words": (size) => fill("aB_", size) + "=value1",
      "a name of many dotted words ending in a secret": (size) =>
        fill("config.", size) + "password: a",
      "cookie lines that read as prose": (size) => fill("cookie: session expired\n", size),
      "webhook URL prefixes with no secret": (size) =>
        fill("hooks.slack.com/services/T1/B1 discord.com/api/webhooks/1 ", size),
      "OpenAI and Anthropic prefixes without bodies": (size) =>
        fill("sk-proj- sk-ant-api03- SG.a. npm_ hf_ xapp- ", size),
      "PGP headers with no end": (size) => fill(pgpBegin + " ", size),
      "one long unbroken run": (size) => fill("a", size),
      "a mixture": (size) =>
        fill('eyJ-sk_live_ a://b:@ "api_key\\" Bearer -----BEGIN password=[ ', size)
    };

    for (const [name, build] of Object.entries(adversarial)) {
      it(`masks ${name} in time proportional to its length`, () => {
        const small = build(16 * KIB);
        const large = build(64 * KIB);
        // Warm, so the first measurement is the matching and not compilation.
        maskSecretsInText(small);
        const atSmall = fastest(small);
        const atLarge = fastest(large);
        expect(atLarge).toBeLessThan(Math.max(8 * atSmall, NOISE_FLOOR_MS));
      });
    }

    it("masks 64 KiB of every adversarial case together in well under a second", () => {
      // The one absolute ceiling, generous enough for a loaded CI runner.
      const all = Object.values(adversarial)
        .map((build) => build(4 * KIB))
        .join(" ");
      const text = fill(all, 64 * KIB);
      maskSecretsInText(text.slice(0, KIB));
      expect(fastest(text)).toBeLessThan(250);
    });
  });
});

/** mulberry32: a small, fast generator whose sequence is fixed by its seed. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The pieces generated text is built from. The first alphabet is the one the
 * review found `token://password://.@` with; the others add the separators,
 * quotes and scheme words the assignment and scheme rules turn on, and whole
 * credentials beside the marker they become.
 */
const GENERATOR_ALPHABETS: Record<string, readonly string[]> = {
  "secret words, URL pieces and separators": [
    "token",
    "password",
    "://",
    ".",
    "@",
    "=",
    ":",
    "a",
    "Z",
    "x",
    "1",
    "9"
  ],
  "the same with blanks, quotes and scheme words": [
    "token",
    "password",
    "://",
    ".",
    "@",
    "=",
    ":",
    " ",
    '"',
    "'",
    "Bearer ",
    "a",
    "Z",
    "x",
    "1",
    "9"
  ],
  "whole credentials, headers and the marker": [
    "sk_" + "live_0123456789",
    "eyJa.eyJb.c",
    "https://",
    "u:p@",
    "password=",
    '"api_key": ',
    "Authorization: ",
    "cookie: ",
    "Bearer ",
    "abcdefgh1",
    "[REDACTED]",
    ".",
    "/",
    " ",
    "'",
    '"',
    ":",
    "=",
    "@",
    "-",
    "_",
    "]",
    "x"
  ]
};

function generate(random: () => number, pieces: readonly string[], maxPieces: number): string {
  const length = 1 + Math.floor(random() * maxPieces);
  let text = "";
  for (let index = 0; index < length; index += 1) {
    text += pieces[Math.floor(random() * pieces.length)] ?? "";
  }
  return text;
}
