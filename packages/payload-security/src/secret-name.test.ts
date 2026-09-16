import { describe, expect, it } from "vitest";
import { DEFAULT_SECRET_PATHS } from "./default-secrets.js";
import { looksLikeSecretName } from "./secret-name.js";

/**
 * Names as real APIs write them, each with where it comes from.
 *
 * The heuristic is judged on both columns. A rule that catches every secret by
 * matching `token` anywhere also warns on `max_tokens` and `nextPageToken` in
 * every payload, and a warning that fires on every deploy is one people learn
 * to ignore.
 */
const SECRET: readonly (readonly [name: string, source: string])[] = [
  ["client_secret", "Stripe PaymentIntent; OAuth token request"],
  ["Stripe-Signature", "Stripe webhook header"],
  ["webhook_secret", "Stripe CLI and endpoint settings"],
  ["secret_key", "Stripe dashboard export"],
  ["cvc", "Stripe card parameters"],
  ["access_token", "Salesforce OAuth response"],
  ["refresh_token", "Salesforce OAuth response"],
  ["id_token", "Salesforce OpenID Connect response"],
  ["signature", "Salesforce OAuth response"],
  ["sessionId", "Salesforce SOAP login result"],
  ["securityToken", "Salesforce login"],
  ["password", "Salesforce login"],
  ["hapikey", "HubSpot legacy API key parameter"],
  ["X-HubSpot-Signature", "HubSpot webhook header"],
  ["X-HubSpot-Signature-v3", "HubSpot webhook header"],
  ["private_app_token", "HubSpot private app"],
  ["X-Hub-Signature-256", "GitHub webhook header"],
  ["X-Hub-Signature", "GitHub webhook header"],
  ["token", "GitHub installation access token response"],
  ["github_token", "GitHub Actions"],
  ["private_key", "GitHub App credentials"],
  ["SecretAccessKey", "AWS STS credentials"],
  ["SessionToken", "AWS STS credentials"],
  ["aws_session_token", "AWS credentials file"],
  ["X-Amz-Security-Token", "AWS signed request header"],
  ["X-Amz-Signature", "AWS presigned URL parameter"],
  ["SecretString", "AWS Secrets Manager GetSecretValue"],
  ["code_verifier", "OAuth PKCE"],
  ["client_assertion", "OAuth private_key_jwt"],
  ["authorization_code", "OAuth token exchange"],
  ["bearer", "OAuth token presentation"],
  ["xoxb_token", "Slack bot token setting"],
  ["bot_token", "Slack OAuth v2 response"],
  ["signing_secret", "Slack app credentials"],
  ["X-Slack-Signature", "Slack request header"],
  ["verification_token", "Slack legacy app credentials"],
  ["app_token", "Slack Socket Mode"],
  ["authToken", "Twilio client settings"],
  ["sessionCredential", "a renamed authToken"],
  ["x-auth-token", "common API gateway header"],
  ["apiKey", "common SDK option"],
  ["X-API-KEY", "common API gateway header"],
  ["passwd", "Unix and database settings"],
  ["db_pwd", "database settings"],
  ["passphrase", "PKCS#12 and SSH key settings"],
  ["passcode", "device unlock settings"],
  ["jwt", "session exchange"],
  ["otp", "one-time password verification"],
  ["totp", "authenticator verification"],
  ["mfa_code", "multi-factor verification"],
  ["card_pin", "card management API"],
  ["pin", "card management API"],
  ["sessionCookie", "browser automation"],
  ["cookies", "request logger"],
  ["PHPSESSID", "PHP session cookie"],
  ["proxy-authorization", "HTTP"],
  ["basicAuth", "HTTP client settings"],
  ["auth", "Node url.parse result"],
  ["encryption_key", "application settings"],
  ["hmac_key", "webhook verification settings"],
  ["credentials", "a connection string holder"],
  ["password2", "a registration form"]
];

const NOT_SECRET: readonly (readonly [name: string, source: string])[] = [
  ["publishable_key", "Stripe"],
  ["payment_intent", "Stripe"],
  ["cvc_check", "Stripe card checks"],
  ["tokenization_method", "Stripe card"],
  ["idempotency_key", "Stripe request"],
  ["livemode", "Stripe"],
  ["client_secret_expires_at", "OAuth dynamic registration"],
  ["instance_url", "Salesforce OAuth response"],
  ["token_type", "Salesforce OAuth response"],
  ["issued_at", "Salesforce OAuth response"],
  ["OwnerId", "Salesforce record"],
  ["LastModifiedById", "Salesforce record"],
  ["hs_object_id", "HubSpot"],
  ["portalId", "HubSpot webhook"],
  ["hubspotutk", "HubSpot form submission"],
  ["hs_email_signature", "HubSpot user settings"],
  ["author", "GitHub commit"],
  ["author_association", "GitHub issue"],
  ["keys_url", "GitHub repository"],
  ["deploy_key", "GitHub deploy key listing (public keys)"],
  ["pinned", "GitHub issue"],
  ["node_id", "GitHub"],
  ["AccessKeyId", "AWS STS credentials"],
  ["NextToken", "AWS list operations"],
  ["ClientToken", "AWS idempotency"],
  ["KmsKeyId", "AWS"],
  ["PartitionKey", "AWS Kinesis"],
  ["SecretId", "AWS Secrets Manager"],
  ["Name", "AWS Secrets Manager"],
  ["x-amz-date", "AWS signed request"],
  ["code_challenge", "OAuth PKCE"],
  ["token_endpoint", "OAuth discovery"],
  ["authorization_endpoint", "OAuth discovery"],
  ["jwks_uri", "OAuth discovery"],
  ["expires_in", "OAuth token response"],
  ["grant_type", "OAuth token request"],
  ["team_id", "Slack"],
  ["bot_id", "Slack"],
  ["X-Slack-Request-Timestamp", "Slack request header"],
  ["nextPageToken", "Google APIs"],
  ["next_cursor", "Slack pagination"],
  ["continuationToken", "Azure pagination"],
  ["syncToken", "Google Calendar"],
  ["max_tokens", "LLM request"],
  ["input_tokens", "LLM usage"],
  ["tokenCount", "the design's own example"],
  ["sessionLength", "the design's own example"],
  ["session", "Stripe Checkout event"],
  ["authorName", "the design's own example"],
  ["spinner", "the design's own example"],
  ["keyboard", "the design's own example"],
  ["monkey", "the design's own example"],
  ["publicKey", "WebAuthn"],
  ["primaryKey", "database schema"],
  ["passwordPolicy", "identity provider settings"],
  ["password_hash", "user export"],
  ["secretary", "contact record"],
  ["secretName", "Kubernetes"],
  ["authMethod", "identity provider settings"],
  ["authenticated", "session state"],
  ["cookieDomain", "session settings"],
  ["PWD", "process environment"],
  ["OLDPWD", "process environment"],
  ["hairpin", "network settings"],
  ["topspin", "sports data"],
  ["pincode", "Indian postal address"],
  ["email_signature", "mail settings"],
  ["signatureMethod", "OAuth 1.0"],
  ["code", "OAuth callback, also every error"],
  ["zip", "address"]
];

describe("looksLikeSecretName", () => {
  it("has a table of at least 40 names on each side", () => {
    expect(SECRET.length).toBeGreaterThanOrEqual(40);
    expect(NOT_SECRET.length).toBeGreaterThanOrEqual(40);
  });

  it.each(SECRET)("accepts %s (%s)", (name) => {
    expect(looksLikeSecretName(name)).toBe(true);
  });

  it.each(NOT_SECRET)("rejects %s (%s)", (name) => {
    expect(looksLikeSecretName(name)).toBe(false);
  });

  it("accepts every built-in secret name, so the walk is what keeps them quiet", () => {
    for (const path of DEFAULT_SECRET_PATHS) {
      expect(looksLikeSecretName(path.slice("**.".length)), path).toBe(true);
    }
  });

  it("gives one answer for every spelling of a name", () => {
    for (const spelling of ["authToken", "auth_token", "auth-token", "AUTH_TOKEN", "AuthToken"]) {
      expect(looksLikeSecretName(spelling), spelling).toBe(true);
    }
    for (const spelling of ["tokenCount", "token_count", "TOKEN-COUNT"]) {
      expect(looksLikeSecretName(spelling), spelling).toBe(false);
    }
  });

  it("drops a version suffix, and nothing else", () => {
    expect(looksLikeSecretName("signature_v2")).toBe(true);
    expect(looksLikeSecretName("apiKey1")).toBe(true);
    expect(looksLikeSecretName("sha256")).toBe(false);
    expect(looksLikeSecretName("oauth2_scopes")).toBe(false);
  });

  it("rejects the empty name and names that are only digits", () => {
    expect(looksLikeSecretName("")).toBe(false);
    expect(looksLikeSecretName("123")).toBe(false);
    expect(looksLikeSecretName("v2")).toBe(false);
  });

  it("answers a very long name without matching across it", () => {
    const long = `${"token".repeat(20_000)}Count`;
    const started = performance.now();
    expect(looksLikeSecretName(long)).toBe(false);
    expect(looksLikeSecretName(`${"a".repeat(100_000)}Token`)).toBe(true);
    // Linear: two 100 KB names in well under a second on any CI machine.
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("finds the version suffix without backtracking over a long run of digits", () => {
    const started = performance.now();
    expect(looksLikeSecretName(`${"1".repeat(100_000)}x`)).toBe(false);
    expect(looksLikeSecretName(`token${"1".repeat(100_000)}`)).toBe(true);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
