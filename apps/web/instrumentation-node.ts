import * as http from "node:http";
import { installSocketAddressCapture } from "./src/lib/socket-address";

// Imported by `instrumentation.ts` in the Node.js runtime only.
installSocketAddressCapture(http);
