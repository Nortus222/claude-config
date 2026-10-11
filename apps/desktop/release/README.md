# Distribution prerequisites

`desktop-release` runs manually on the exact reviewed `main` SHA after its required checks pass.
Enter the committed desktop version and plain-text notes. Leave **publish** unchecked for a validation
run: it builds, signs, submits Apple notarization, staples, checks Gatekeeper and updater signatures,
runs the temporary-HOME packaged smoke, and uploads workflow artifacts retained for seven days.
It creates no public release or stable-channel update. Selecting **publish** runs those same checks
before creating versioned GitHub Releases and advancing the separate stable metadata release.

Nested Bun uses only `com.apple.security.cs.allow-jit`. A copied Bun 1.3.14 binary signed with Developer
ID, hardened runtime and a secure timestamp executed optimized JIT code and passed 102 desktop pure
tests on macOS Apple Silicon. The workflow checks the final nested binary has exactly this entitlement;
it is not applied to the GUI. `com.apple.security.get-task-allow` must not be true.

Whole-app notarization and Gatekeeper acceptance still need a successful validation run. Real signed
N-to-N+1 installation, launchd handoff, interrupted recovery and machine-state preservation remain
separate acceptance work. The owner deferred isolated OS testing; a successful build or packaged smoke
does not prove these behaviors.

The updater public key is supplied through the `DESKTOP_UPDATER_PUBLIC_KEY` repository variable.
There is no production key or placeholder in this checkout. The release overlay is generated under
`RUNNER_TEMP`; ordinary PR, push and local validation builds have no updater key or signing secrets.
