# The edge router image

What `.github/workflows/edge-image.yml` builds, and how to read what it
leaves behind. The why is in that file's header; the short of it is that a
router nobody can log in to gets its Xen guest agent from the image or not
for a day, and an image built in one place is the only version of "the
router" that is one thing.

## What a run produces

A GitHub release tagged `edge-image/<opnsense_version>-<YYYYMMDD>-<run>`,
never reused, with three assets:

| asset | what it is |
|---|---|
| `fleetwright-edge-<release>-<version>-amd64.img.zst` | OPNsense's nano image for `<release>`, booted once, updated to `<version>` (the current patch level of that release), with `os-xen` installed, cleaned, and compressed with `zstd -19`. `zstd -d` gives back the 3 GiB raw disk |
| `manifest.json` | everything the host needs to know about it, below |
| `SHA256SUMS` | the image's and the manifest's digests, `sha256sum -c` form |

The image carries a build provenance attestation:
`gh attestation verify fleetwright-edge-….img.zst --repo <owner>/Fleetwright`.

On a pull request the same three files are a workflow artifact, `edge-image`,
kept three days. Every run keeps `edge-image-console`, the whole serial
console conversation and the facts the guest answered, for fourteen days;
when a run fails, that log is where the answer is.

## Reading the manifest

```json
{
  "opnsense_release": "26.7",          // the upstream release built from
  "opnsense_version": "26.7.5",        // what `opnsense-version -v` said after the update
  "os_xen": "…",                       // the agent's package version
  "upstream_url": "…", "upstream_sha256": "…",   // the image it started from, as pinned
  "commit": "…", "workflow_run": "…", "built_at": "…", "accel": "kvm",
  "raw_size": 3221225472,
  "compressed": { "name": "…", "sha256": "…", "size": …, "format": "zstd" },
  "config": {
    "path": "/usr/local/etc/config.xml",
    "offset": 712876032, "length": 5234, "sha256": "…",   // what OPNSENSE_IMAGE.config pins
    "inode": 6523,
    "same_as_pinned": true,              // byte for byte the upstream release's, at the same place
    "owner": null                        // the package that owns the file, or null for none
  },
  "grow": { "room": 32768, "inode": 6523, "data": { "offset": …, "length": 32768 }, "edits": [ … ] },
  "packages": [ "…" ],                  // `pkg query '%n-%v'`, sorted
  "ran": { … }                           // what each update command printed
}
```

`config` is the stock configuration file as the image ships it: the host
checks the bytes at `offset` against `sha256` before it writes a
configuration there (`isDefaultConfig`), so these three numbers are the
pin. `grow` is the room plan from `scripts/opnsense-room.mjs`, run against
the finished image: the whole block the configuration moves to and every
byte of the file system that records the move, which the host checks
before replacing. Both were found from the image's own inode and the bytes
at the offset were hashed against what the guest reported for the file, so
an offset in a manifest is one two witnesses agreed on.

`same_as_pinned` says whether the update left the file where the upstream
image had it. When it is `false`, the host-side pin has to move with the
image.

## Running the driver yourself

With QEMU installed and the raw image unpacked (`bzip2 -dc … > edge.img`):

```sh
node scripts/edge-image/drive.mjs --image edge.img --accel kvm --log console.log --facts facts/
node scripts/edge-image/measure.mjs --image edge.img --facts facts/ --compressed edge.img.zst \
  --release 26.7 --upstream-url … --upstream-sha256 … --manifest manifest.json --notes notes.md
```

`--accel tcg` works without `/dev/kvm` and takes most of an hour. The
driver's header lists what it assumes about the console; the constants at
the top of it are where a release that moves a prompt is fixed.
`test/edge-image-drive.test.js` runs the whole conversation against a fake
guest, which is the way to check a change to the order of things without a
VM; `test/edge-image-console.test.js` covers the sentinel reading.

## What is deliberately not here yet

The host still downloads from OPNsense's mirror (`OPNSENSE_IMAGE.url` in
`src/fleet/host/edge-router.js`). Pointing it at these releases is a
separate change, once a release exists to point at: the pin becomes a
release tag that Renovate moves with the `github-releases` datasource over
`edge-image/*` tags, the address a release asset's, the digest the
manifest's, and `unpack` learns zstd beside bzip2. Nothing in
`renovate.json` names this workflow until then.
