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
