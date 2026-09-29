// The heartbeat: two frames, spelled once, so both ends of the socket agree.
//
// WHY THIS EXISTS. A fleet host holds its socket open for weeks behind a NAT,
// and a dead TCP connection is indistinguishable from an idle healthy one until
// somebody writes to it. The sidecar used to keep itself honest with a
// WebSocket protocol ping every twenty seconds and a pong deadline — control
// frames, below the messages — and that was the one thing Node's own
// `WebSocket` cannot do: the platform API has no ping. So the sidecar carried
// four hundred lines of hand-rolled RFC 6455 framing for the sake of one
// control frame, in the code path every host runs permanently.
//
// This is that ping, as a message. The host sends HEARTBEAT_PING; the
// coordinator answers HEARTBEAT_PONG. Text frames, so any WebSocket can send
// them, and JSON, so nothing on this wire is ever not JSON — a `kind` the
// dispatchers already switch on, rather than a bare word they would have to
// special-case before parsing.
//
// THE BYTES MATTER, which is why these are strings and not objects. On
// Cloudflare the Durable Object answers this with `setWebSocketAutoResponse`,
// which matches the request BYTE FOR BYTE and replies without waking the
// object — the heartbeat then costs nothing, exactly as the protocol-level
// ping did. Build the frame with JSON.stringify somewhere else and a key
// order or a space would make it a message that wakes the object every
// twenty seconds per host. Both coordinators import these; the sidecar imports
// these; nothing spells them a second time.
//
// Not versioned under PROTOCOL_VERSION: that number governs intent envelopes
// (verbs and their params, append-only). A coordinator older than this frame
// reads it as a `kind` it does not know and drops it with a warning, and the
// runtime still answers the protocol-level ping an older sidecar sends. So
// each side can move first: a new coordinator serves old hosts, and a new
// host against an old coordinator falls back to the rule in the transport —
// any frame at all is proof of life, and only total silence drops the socket.

/** What a host sends to ask "are you there". */
export const HEARTBEAT_PING = '{"kind":"ping"}';

/** What the coordinator sends back. */
export const HEARTBEAT_PONG = '{"kind":"pong"}';

/**
 * Is this frame a heartbeat, and which half?
 *
 * For the code that handles frames as TEXT before parsing them — the sidecar's
 * transport, which should not log a pong as "the coordinator sent something
 * that is not an intent". Dispatchers that have already parsed look at
 * `kind` instead.
 *
 * @param {unknown} text
 * @returns {'ping'|'pong'|null}
 */
export function heartbeatKind(text) {
  if (text === HEARTBEAT_PING) return 'ping';
  if (text === HEARTBEAT_PONG) return 'pong';
  return null;
}
