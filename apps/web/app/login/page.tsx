export default async function LoginPage({
  searchParams
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const message =
    error === "throttled"
      ? "Too many attempts. Try again shortly."
      : error === "invalid"
        ? "Invalid token."
        : null;

  return (
    <main className="centered">
      <h1>Flight Recorder</h1>
      <p className="muted">
        Sign in with the <code>ADMIN_TOKEN</code> this installation was started with.
      </p>
      {message === null ? null : <p className="error">{message}</p>}
      <form method="post" action="/api/login" className="stack">
        <label htmlFor="token">Admin token</label>
        <input id="token" name="token" type="password" autoComplete="off" required />
        <button type="submit">Sign in</button>
      </form>
    </main>
  );
}
