# Browsing through a machine

A web view on the phone whose connections leave from one of your machines.
Asked for in three parts, then as one: *"Web view that proxies any web page
through one of our hosts?"*, and when the three ways it could be bounded were
laid out, *"All 3 combined"*.

So one screen does three things, each with its own bound:

| What | Opened from | Reaches | Who |
|---|---|---|---|
| **A session's port** | a running session's page, Open a port | `localhost` inside that session's container, any port | the session's owner, on a machine that contains sessions |
| **Addresses the box lists** | a machine's page, Browse | the names and ranges its owner wrote in `FLEETWRIGHT_BROWSE_HOSTS` | people who administer that machine |
| **The public web** | the same | public addresses on ports 80 and 443, when its owner set `FLEETWRIGHT_BROWSE_WEB=on` | the same |

A session's page reached through Open a port can also load what the page
pulls from elsewhere, by the machine's rules, for somebody who administers
it. For anybody else those other addresses are refused, and the session's own
port still works.

## The shape

```
web view ──CONNECT──▶ phone's loopback proxy ──WebSocket──▶ coordinator ──frames──▶ box ──TCP──▶ the page
```

It is the console from away ([manage.md](./manage.md), "The console") with
one difference that makes it a new thing: a page is dozens of connections, so
one phone socket carries many **streams**, each one TCP connection the box
makes. The console's tunnel carries exactly one, and that bound stays where
it is.

**The phone still holds the TLS.** The web view is pointed at an HTTP proxy
on the phone's own loopback, which answers `CONNECT host:port` by opening a
stream to the box. For an `https://` page the web view opens TLS through the
stream itself, to the page's own name, checked by the system's own trust. The
box and the coordinator carry TLS records and see the host name and the port,
which is what a `CONNECT` names, and nothing inside.

**A plain `http://` page is readable on the way**, by the box and by the
coordinator, which is what plain HTTP means anywhere. A session's dev server
is the usual one, and it is the person's own work on the person's own
machine. The screen says when the page it shows is not secure.

**Only the web view may use the proxy.** Loopback is every app on the
phone, and on Android any app can connect to it, while this proxy spends the
person's credential on a box's address. So it answers only a request that
carries a name and password made at random for that screen, with `407` and
nothing else otherwise. The web view is given them: iOS on its proxy setting
(`applyCredential`) and by answering its proxy challenge, Android by
answering `onReceivedHttpAuthRequest` for that proxy and cancelling every
other sign-in prompt rather than answering it with them.

**Absolute-form requests too.** Android's web view sends a plain-HTTP request
to a proxy as `GET http://host/path`, not as a `CONNECT`. The phone's proxy
opens a stream to that host, rewrites the first line to `GET /path`, asks the
server to close after one answer (`Connection: close`), and drops the
`Proxy-` headers. The next request opens the next stream.

## What bounds it

The coordinator is the party this project treats as compromised
([security.md](./security.md)), so every bound that matters is the box's own.

**The box decides every connection** (`src/fleet/host/browse.js`):

1. **`localhost` is the session's**, and only when the socket was opened on
   one. `localhost`, `127.0.0.1` and `::1`, on any port, go to that session's
   container, through the hub, which owns the container
   (`src/core/session-port.js`). Without a session they are refused.
   **The box never opens itself**: its loopback, which is the hub, the
   sidecar and every service on it, every address of its own interfaces, and
   the unspecified addresses, which a connect sends to the box. Addresses are
   compared by number, not by how they are written, so
   `2a02:1234:0:0:0:0:0:5` is the box at `2a02:1234::5` and `::ffff:c0a8:105`
   is `192.168.1.5`.
2. **A name the box lists** is opened as the box's own resolver answers it, on
   the port the entry names, or on 80 and 443.
3. **Every other name is resolved on the box**, once, and the box connects to
   the address it got, never to the name again. An address inside a range the
   box lists is opened, on that entry's port or on 80 and 443.
4. **A public address**, on port 80 or 443, when the box has the public web
   turned on. Public means not loopback, private, link-local, shared,
   multicast, documentation, benchmarking or reserved, in IPv4 or IPv6, with
   an IPv4 address written inside IPv6, in either spelling, judged as the IPv4
   address, and **not on a network the box itself is on**: on an IPv6 network a
   box's neighbours have global addresses too, and they are its owner's
   network, opened only if listed. A name is opened only on an address that
   passes, and the box connects to that address: a name that resolves only
   to private addresses is refused, and one that resolves to both is opened
   on the public one. There is no second resolution for DNS rebinding to
   change.
5. **Anything else is refused**, with a sentence the phone shows as the page.

Box rules 2 to 4 apply only on a socket the coordinator opened for somebody
who administers the box. A box that pins its admins
([signed-intents.md](./signed-intents.md), "Pinned admins") also refuses
them for anybody it does not pin.

**A session's port has more checks, on the hub.** The session must be
running, must be the person's (`createdBy`), and the box must contain its
sessions: on a box that runs them as plain panes a session's `localhost` is
the box's own, so its ports are not opened from a phone. The hub runs one
short `podman exec` into that container per connection, which connects to the
port inside it and pumps bytes. The sidecar never touches podman, because it
runs as its own user (#270) and the container is the hub's.

**Off by default.** A box opens its listed names and the web only when its
owner wrote them in its env file, which is the same trust as everything else
in that file. A session's port needs nothing turned on: it is already the
person's own.

**Sizes.** On the coordinator: one socket per screen, thirty minutes and 512
MiB at most, 32 connections open at once on it, two sockets per person and 16
in the fleet. On the box: 64 connections at once across every socket, ten
seconds to resolve a name and fifteen to connect, and a connection quiet for
thirty minutes is closed.

**How fast.** A connection's bytes toward the phone are acknowledged by the
phone as it hands them to the web view (`ack`), and the box reads no more
than 128 KiB of one connection ahead of that. Without it a file served at LAN
speed to a phone on a slow link piled up in every socket between, the
coordinator's among them. Bytes from the phone to the box have no window:
they are what the web view uploads, at the phone's own speed.

**A socket with a hole in it is closed.** When the box's socket to the fleet
drops, whatever was in flight is gone, so the box closes the pages it was
carrying the moment a frame cannot be sent, the coordinator closes them when
the box dials again, and a box asked about a page it no longer has says so.
The phone shows the sentence and Open again.

**What a compromised coordinator gets** is what the box's owner turned on:
pages on the names they listed and the public web, from that box's address,
and plain-HTTP pages readable on the way. **And every contained session's
ports on the box, as that session's person:** the person a socket is for is
the coordinator's word, unsigned, and it sees who started each session, so
it can name the right one. That reaches dev servers and anything else a
session listens on, which on a box that takes only signed work
(`FLEETWRIGHT_REQUIRE_SIGNED=all`) is a way into sessions the signature does
not cover. It is listed with the other things the coordinator says alone
([signed-intents.md](./signed-intents.md)); a phone-signed delegation for the
socket is what would close it, and is not built. It cannot reach an address
the box does not list, the box itself, or a session that is not running or
not contained. That is the cost of the feature, written down here because it
is the one thing the console's tunnel did not have: a tunnel there could
reach only a pool the box held a token for.

**Whose address the web sees.** Every page opened through a box comes from
that box's address. That is why the web is the owner's switch, and why only
people who administer the box can use it.

## The protocol

Protocol **18**: `browse` frames, both ways between the coordinator and a
box. Frames, not a verb, so an older box would drop them and the screen would
hang; the coordinator opens a socket only through a box that speaks 18.

The phone's socket is `GET /api/browse?host=<hostId>[&session=<name>]`.

| From | `op` | Says |
|---|---|---|
| coordinator, to the phone | `ready` | which box, the session, what the box opens for this person, and the limits |
| | `open` | the box agreed; the proxy may listen |
| | `connected` / `failed` | one stream connected, or why not |
| | `data` / `end` | one stream's bytes, base64, or its end |
| | `closed` | the whole socket ended, and why |
| the phone | `connect` | a stream: `stream`, `host`, `port` |
| | `data` / `end` | the same, for one stream |
| | `ack` | `bytes` of a stream it has handed to the web view |
| coordinator, to the box | `open` | the person, the session, and whether box rules apply |
| | `connect` / `data` / `end` / `ack` | as the phone's; the person and the session went with `open`, from the coordinator's own record |
| | `close` | the phone's socket went |
| the box | `opened` / `refused` | the socket, or why not |
| | `closed` | it no longer has that socket, and why |
| | `connected` / `failed` / `data` / `end` | as above |

The box reports what it opens on its health frame, as `browse`:
`{ sessions, web, hosts }`. `sessions` is whether it contains its sessions,
which is what Open a port needs, and every person sees it. `web` and `hosts`
are its owner's settings, and only people who administer the box see them
(`core.js` visibleHost). A box older than 18 sends no `browse`, and neither
button is drawn for it (C-2).

## On the phones

- **Open a port**, on a running session's page, where its machine says
  `sessions`. It asks for a port and opens `http://localhost:<port>/`.
- **Browse**, on a machine's page, for somebody who administers it, where it
  opens a listed name or the web. It opens an address bar with the box's
  listed names under it.

The web view keeps nothing: no cookies, no cache and no storage outlive the
screen (`nonPersistent` on iOS, cleared on Android when it closes). The
address bar shows the page's address and says when it is not secure. A page
the box refused shows the box's sentence.

iOS sets the proxy on the web view's data store (`proxyConfigurations`), so
it reaches this web view and nothing else. Android sets it for the app's web
views with AndroidX WebKit's `ProxyController`, which is the only way it has,
and takes it off when the screen closes. `removeImplicitRules()` sends
`localhost` through the proxy too, which Chromium otherwise sends straight to
the phone's own loopback.

**Not measured on a device yet**, and said here so nobody reads the tests as
having measured it:

- whether iOS sends `localhost` through a proxy set this way. If it does not,
  Open a port reaches the phone's own loopback and says it could not
  connect, and the fix is a name the box maps to the session instead;
- whether each web view answers the proxy's `407` with the name and
  password it was given. If one does not, every page on it fails at once
  with the proxy's refusal, which is loud rather than wrong.

What is measured is everything behind the phone: `test/browse.test.js`
drives the coordinator, the box and the hub with real sockets, real TLS and
the real dial script, and `test/browse-in-apps.test.js` holds both apps'
source to the contract above.
