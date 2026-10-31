# xo-server-fleetwright-reconnect

An xo-server plugin that reconnects this Xen Orchestra's servers when one is
left disconnected or stuck connecting. It does on its own what Reconnect in
the Fleetwright app does by hand.

- **A server stuck "connecting"** for ten minutes is disconnected and
  connected again. Xen Orchestra's own retry only acts on "disconnected".
- **A server left "disconnected"** for three minutes is connected. On a Xen
  Orchestra new enough to retry by itself, that retry usually gets there
  first.
- **A second server for a pool another server holds stands by**, and is
  connected once that server drops. A pool master that answers on two
  addresses by turns can be listed twice, and is reached on whichever is up.
- **A server someone turned off stays off.** One whose pool master refuses
  its password is named once in xo-server's log and left for a person.
- **It backs off**, waiting twice as long after each try, up to half an hour.

It runs inside Xen Orchestra, so it holds no token or password, and it has no
settings, so Xen Orchestra loads it as soon as it is installed.

Installed by Fleetwright with Xen Orchestra, or once by hand on an existing
install: see `docs/hypervisors.md`, "When Xen Orchestra loses a pool", in the
Fleetwright repository.
