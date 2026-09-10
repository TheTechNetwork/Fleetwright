# Play listing assets

Generated, not drawn. `tools/make-app-icon.py` writes all three store images —
the iOS app icon, the icon here, and the feature graphic — from one piece of
geometry, so the mark cannot drift between the two stores. Resizing a PNG by
hand at eleven at night is exactly how it does drift.

```sh
python3 tools/make-app-icon.py
```

| file | size | where it goes |
|---|---|---|
| `icon-512.png` | 512×512 | Play listing icon. Required for **every** track, internal included |
| `feature-graphic-1024x500.png` | 1024×500 | Play listing. Only needed for the public tracks |
| `screenshots/phone-0*.png` | phone | Play wants at least two for a public listing; these came from the emulator against a real coordinator, because inventing them would be inventing the product |

The icon and feature-graphic sizes are fixed by Google and neither is
negotiable.

## Retaking the screenshots

The pictures are the one asset `make-app-icon.py` cannot generate — they have
to come off a running app — which is why they went stale when the tab shell was
redesigned ([#268](https://github.com/TheTechNetwork/Fleetwright/issues/268))
while the App Store set did not. iOS retakes its own from
`scripts/ios-screenshots.sh`; this side had the uploader and neither half of
what feeds it.

The half that is fixable in code is now here. A **debug build** launched with
one extra starts on the demo fleet, so the app has hosts and sessions in it
before the first picture instead of an empty state and a Connect button:

```sh
adb shell am start -n network.thetech.fleetwright/.MainActivity   --ez fleetwright-demo true
```

It writes exactly what the Demo button in Settings writes, from the constants
in `Demo.kt`. **Release builds have no such path** — `Screenshots.kt` compiles
it out entirely, because an Intent extra is reachable over `adb` on any phone
with debugging on, which an iOS launch argument is not.

What still needs a person is the emulator and the five taps: launch with the
flag, then capture Sessions, a notification, a peek, the actions and Settings
at the sizes above.
