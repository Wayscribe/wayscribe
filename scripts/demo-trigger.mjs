const SOURCE_URL = process.env.DEMO_SOURCE_URL ?? "http://localhost:3100";
const WEB_URL = process.env.DEMO_WEB_URL ?? `http://localhost:${process.env.WEB_PORT ?? "3000"}`;

const response = await fetch(`${SOURCE_URL}/trigger`, { method: "POST" }).catch(() => undefined);

if (response === undefined || !response.ok) {
  console.error(
    response === undefined
      ? `Could not reach the demo source at ${SOURCE_URL}.`
      : `The demo source responded ${response.status}.`
  );
  console.error("Is the demo stack running? See docs/LOCAL_DEVELOPMENT.md.");
  process.exit(1);
}

const { journeyId } = await response.json();

console.log("\nJourney started.\n");
console.log(`  ${WEB_URL}/journeys/${journeyId}\n`);
console.log("Or sign in and search:\n");
console.log("  0018Z00002ABC\n");
console.log("It takes about ten seconds to reach its dead-letter state.\n");
