# Local build — a DMG without an Apple account

```bash
npm run pack:local     # → release/Mull-0.0.1-arm64.dmg
```

That is the whole command. It builds the sidecar, builds both bundles, packages
a real `Mull.app`, signs it ad-hoc, checks that the signed bundle actually runs,
and wraps it in a DMG. No Apple ID, no certificate, no notarisation, nothing
uploaded anywhere.

---

## What you get, and what you don't

An Apple Developer ID buys exactly one thing: the right to hand the app to
**someone else**. Everything else about a Mac app works without it.

| | local build | notarised build (M6) |
|---|---|---|
| Installs into /Applications | ✅ | ✅ |
| Own icon, own name in TCC prompts | ✅ | ✅ |
| Microphone, Accessibility, Input Monitoring | ✅ | ✅ |
| Survives a rebuild without re-granting permissions | ❌ | ✅ |
| Opens on another Mac after a download | ❌ | ✅ |
| Costs $99/year | no | yes |

The signature is **ad-hoc** (`codesign --sign -`): a valid signature with no
identity behind it. macOS runs it happily here, because the file never picked up
a quarantine flag. The same file downloaded or AirDropped to another Mac is
refused outright — `spctl -a` says `rejected`, and that is by design, not a bug
in the build.

Ad-hoc is not the same as unsigned. Apple Silicon refuses to execute an entirely
unsigned binary, so "just skip signing" produces a DMG that cannot launch. This
is why `pack:local` signs the bundle itself rather than letting electron-builder
skip it.

## Install

```bash
open release/Mull-0.0.1-arm64.dmg
```

Drag Mull to Applications, eject, launch. There is no Dock icon and no window —
`LSUIElement` is set, so the HUD is the only visible part.

Two things live **outside** the bundle and are shared with `npm run dev`:

- the speech model, at `~/Library/Application Support/mull/models/ggml-base.en.bin`
- `whisper-cli`, from `brew install whisper-cpp`

So a packaged Mull uses the model you already fetched, and writes to the same
`bench.jsonl` and `journal.db`. Deleting the app leaves all of it in place.

## Permissions after every rebuild — the one real tax

macOS remembers a permission grant against the app's **code signature**. A
Developer ID signature is stable across builds; an ad-hoc one is a hash of the
binary, so every rebuild is, to TCC, a different app wearing the same name.

The symptom is specific and confusing: Mull still appears in **System Settings →
Privacy & Security → Accessibility** with its switch **on**, and the API still
reports no access. The stale entry has to go before a fresh grant will take.

After replacing the app:

```bash
tccutil reset Accessibility net.mull.app
tccutil reset ListenEvent net.mull.app     # Input Monitoring
tccutil reset Microphone net.mull.app
```

Then launch Mull and grant all three again. (Or do it by hand: select the Mull
row, press **−**, relaunch, grant.) Restart the app after granting — the checks
run at boot.

`net.mull.app` is the bundle id in `electron-builder.yml`. It is a placeholder
that only ever mattered for publishing, so for a local-only build it can stay —
but **keep it stable**, because it is the name TCC files your grants under.
Changing it later means re-granting everything again.

## Rebuilding

```bash
npm run pack:local
```

Then quit Mull, replace `/Applications/Mull.app`, run the three `tccutil` lines
above, and relaunch. The `release/` directory is rebuilt in place; it is not
committed.

## If something goes wrong

**The app quits the instant it launches.** Almost always the hardened runtime,
which exists only to satisfy notarisation and is therefore optional here:

```bash
MULL_LOCAL_HARDENED=0 npm run pack:local
```

`pack:local` already proves the signed binary can execute and can load its
native modules before it builds the DMG, so this should be rare.

**"Mull is damaged and can't be opened."** The file picked up a quarantine flag
by travelling — an AirDrop, a download, a cloud-synced folder:

```bash
xattr -dr com.apple.quarantine /Applications/Mull.app
```

**Nothing is inserted, no prompt appears.** Stale TCC entry — see above.

**Logs.** `~/Library/Logs/mull/main.log`. The boot line `permissions {...}`
reports what macOS actually granted and which `hotkeyMode` was reached.

## What this build does not settle

`docs/INSERTION-MATRIX.md` calls for its final pass on a *notarised* bundle,
because a few apps and TCC itself treat a properly signed app differently. A
local build gets most of the way there — real bundle id, real Info.plist, real
app identity in the permission prompts — but it is not that pass, and the matrix
should say which build produced each row.

If you ever do want to distribute, nothing here is wasted: the entitlements,
hardened runtime and signing order are the same, and `npm run notarize:dryrun`
lists the three credentials that would then be needed.
