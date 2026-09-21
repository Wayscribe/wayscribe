// Package wayscribe provides the unreleased Wayscribe Go recorder.
//
// Values are captured synchronously without calling application marshal or
// string methods. Caller-owned maps and slices must remain stable during capture.
// Full payload capture and propagation of entity IDs require explicit opt-in.
// Labels and displayable aliases are public text and must not hold personal data.
package wayscribe
