# Distribution prerequisites

`desktop-release` deliberately stops until the owner adds a reviewed `bun-entitlements.plist` here.
Validate the selected entitlements with the pinned Bun runtime, hardened runtime, Developer ID,
notarization, Gatekeeper, and a disposable Mac's real agent and updater lifecycle. Do not copy Bun's
upstream exceptions onto the GUI or treat a successful fixture/build as distribution acceptance.
`com.apple.security.get-task-allow` must not be true.

The updater public key is supplied through the `DESKTOP_UPDATER_PUBLIC_KEY` repository variable.
There is no production key or placeholder in this checkout. The release overlay is generated under
`RUNNER_TEMP`; ordinary PR, push and local validation builds have no updater key or signing secrets.
