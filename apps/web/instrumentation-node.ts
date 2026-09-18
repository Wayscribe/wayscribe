import * as http from "node:http";
import { installSocketAddressCapture } from "./src/lib/socket-address";
import { refuseToStartMisconfigured } from "./src/lib/startup";

// Imported by `instrumentation.ts` in the Node.js runtime only, once, before
// the server takes a request.

// First, so a misconfigured container exits with the setting named rather than
// starting, passing its health check, and failing the first sign-in (F-030).
refuseToStartMisconfigured(process.env);

installSocketAddressCapture(http);
