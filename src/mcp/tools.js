// The fleet's verbs, as MCP tools.
//
// GENERATED FROM THE VERB REGISTRY, NEVER WRITTEN OUT. `src/fleet/protocol/
// intents.js` already carries everything a tool schema needs — the parameter
// names, their types, which are required, the enum values, the length bounds
// and a summary — because the protocol was designed as a fixed typed verb set
// and that is the same shape MCP asks for.
//
// Writing the tools by hand would create a second list to keep in step, and the
// failure would be silent in the worst direction: a tool that offers a
// parameter the host will refuse, or omits one the verb needs, discovered by an
// agent mid-task rather than by anybody reading either file. Adding a verb is
// already free (an old host answers `unknown_verb`); this makes adding a TOOL
// free too.
//
// WHAT IS DELIBERATELY NOT EXPOSED is the interesting half — see DEFAULT_DENY.

import { VERBS } from '../fleet/protocol/intents.js';

/**
 * Verbs a fleet MCP server does not offer unless it is told to.
 *
 * NOT A SECURITY BOUNDARY. Whoever runs this holds a device credential and can
 * call `/api/intent` directly; the coordinator is what decides authority, and
 * it has not changed. This is about what an AGENT should reach for without
 * being asked, which is a different question from what a person may do.
 *
 *   reboot, upgrade, update   restart a machine somebody else is working on
 *   purge, forget            destroy a conversation that cannot be recovered
 *   connect, link, unlink    move somebody's credentials around
 *
 * `answer` is the one worth arguing about and it stays out by default. A
 * subagent answering another agent's prompt is not a permission question, it is
 * a POLICY one: the prompt exists because a session stopped to ask a person
 * something, and an agent that answers it has decided on that person's behalf
 * that it knew what they wanted. Sometimes true. Never true by default.
 */
/** @type {string[]} */
export const DEFAULT_DENY = ([
  'reboot', 'upgrade', 'update', 'purge', 'forget', 'restore',
  'connect', 'link', 'unlink', 'renew', 'answer',
]);

// `stop` is NOT on that list, and that is a change rather than an oversight.
//
// It was, on the reasoning that ending work is not something an agent should
// reach for unasked — which is true of somebody else's work and false of its
// own. An agent told "clean up after yourself" and given no way to do it will
// leave a paid-for runner idling, and the instruction becomes a lie the moment
// it is read.
//
// So the verb is exposed and SCOPED: the server refuses to stop a session it
// did not start in this conversation. See McpServer#call.

/**
 * Extra tools that map onto a verb already exposed.
 *
 * `fleet_read_log` is `logs` with the session half brought to the front. The
 * verb does two jobs — a service journal, and a session's own console output —
 * and a single tool called `fleet_logs` reads as the first one. An agent looking
 * for what a job printed had no reason to open it.
 *
 * Asked for directly ("fleet_readLog to read console output rather than peek"),
 * and it is the right shape: peek is the live screen and disappears with the
 * session, while this is what the session SAID and survives it. On a runner
 * that is the difference between collecting a result and losing it.
 *
 * An alias rather than a new verb, so the protocol is unchanged and an old host
 * answers it identically.
 */
const aliasesFor = (/** @type {number} */ maxWaitSeconds) => [
  {
    name: 'fleet_await',
    verb: 'status',
    description:
      'Wait for a session to finish, instead of polling. Returns as soon as it has ended, has errored, or ' +
      'the timeout passes — whichever comes first. Use this after fleet_start rather than checking repeatedly.',
    // Not a protocol verb. `status` is what it asks the fleet, repeatedly, and
    // the waiting happens in this server — see McpServer#await. The parameters
    // are its own.
    schema: {
      name: { type: 'string', description: 'The session to wait on.' },
      seconds: {
        type: 'integer',
        minimum: 5,
        // THE CEILING THE CALLER WILL ACTUALLY GET. It was 900 on both
        // transports while HTTP capped a wait at 25s, so an agent could ask for
        // two minutes, plan around it, and be answered in twenty-five seconds —
        // legible afterwards from the reply's prose, invisible before.
        maximum: maxWaitSeconds,
        description:
          maxWaitSeconds < 900
            ? `How long to wait. This connection caps a single wait at ${maxWaitSeconds}s and then says so; call again to keep waiting.`
            : 'How long to wait before giving up and saying so.',
      },
    },
    requires: ['name'],
    local: true,
  },
  {
    name: 'fleet_read_log',
    verb: 'logs',
    description:
      "Read a session's console output — everything it printed, not just what is on screen now. " +
      'Survives the session ending, so this is how you collect a result. `peek` shows the live pane instead.',
    // The session half only. `service` is a different question and has its own
    // tool; offering both here would rebuild the ambiguity this exists to end.
    omit: ['service'],
  },
];

/**
 * Verbs whose tool shows less than the verb does.
 *
 * ONE TOOL, ONE QUESTION. `logs` does two jobs — a service journal and a
 * session's own console output — and exposing both on one tool while
 * `fleet_read_log` also offers the session half produced two tools whose
 * descriptions both said "read a session's output, it survives the session
 * ending". An agent testing this server reported them as near-duplicates and
 * could not tell why both existed. It was right: nothing distinguished them.
 *
 * So the split is made real rather than described. `fleet_read_log` is the
 * session half and `fleet_logs` is the service half, and neither mentions the
 * other's job. No capability is lost — every parameter is still reachable — and
 * the protocol is untouched, because this is presentation and `logs` remains
 * one verb with both parameters.
 */
/** @type {Record<string, { description?: string, omit?: string[] }>} */
const OVERRIDE = {
  logs: {
    description:
      'Read a service journal on one host — the hub, the coordinator or the sidecar. ' +
      "For what a SESSION printed, use fleet_read_log instead.",
    omit: ['name'],
  },
};

/**
 * JSON Schema for one protocol parameter.
 * @param {string} name @param {any} spec
 */
function schemaFor(name, spec) {
  /** @type {Record<string, any>} */
  const out = {};
  switch (spec.type) {
    case 'int':
      out.type = 'integer';
      // The bounds travel. An agent that can see them asks for something
      // acceptable; one that cannot finds out by being refused.
      if (typeof spec.min === 'number') out.minimum = spec.min;
      if (typeof spec.max === 'number') out.maximum = spec.max;
      break;
    case 'enum':
      out.type = 'string';
      out.enum = [...(spec.values || [])];
      break;
    case 'name':
      out.type = 'string';
      out.description = 'A session name. Ask `list` for the ones that exist.';
      break;
    case 'secret':
      out.type = 'string';
      // Named as a secret so a client that redacts anything, redacts this.
      out.description = 'A credential. Sent once, never echoed back.';
      break;
    default:
      out.type = 'string';
      if (typeof spec.max === 'number') out.maxLength = spec.max;
  }
  return out;
}

/**
 * The tool list, from the verbs.
 *
 * @param {{ allow?: string[]|null, deny?: string[], budgetMinutes?: number, maxWaitSeconds?: number }} [opts]
 *   `maxWaitSeconds` is the ceiling THIS transport will honour on a blocking
 *   tool, so the schema advertises what the caller will actually get.
 *   `allow` names verbs to expose beyond the safe set; null means the default.
 *   `budgetMinutes` is stated in the descriptions that need it — the lifecycle
 *   is the agent's to manage, so the numbers it manages against have to be in
 *   front of it rather than in a document somebody else read.
 * @returns {Array<{ name: string, description: string, inputSchema: any, verb: string, mutating: boolean, local?: boolean }>}
 */
export function toolsFor({ allow = null, deny = DEFAULT_DENY, budgetMinutes = 15, maxWaitSeconds = 900 } = {}) {
  const extra = new Set(allow || []);
  /** @type {Array<{ name: string, description: string, inputSchema: any, verb: string, mutating: boolean, local?: boolean }>} */
  const tools = Object.entries(VERBS)
    .filter(([verb]) => !deny.includes(verb) || extra.has(verb))
    .map(([verb, def]) => {
      /** @type {Record<string, any>} */
      const properties = {};
      const required = [];
      for (const [param, spec] of Object.entries(def.params || {})) {
        properties[param] = schemaFor(param, spec);
        if (spec.required) required.push(param);
      }
      // `host` is not a protocol parameter — it is placement, carried beside
      // the intent. Offered on every tool because addressing one box by name is
      // the only way to reach an ephemeral host, which is the case this server
      // exists for.
      properties.host = {
        type: 'string',
        description: 'Run on this host by name. Required to reach a temporary host: those are never chosen automatically.',
      };
      // A TAG IS PLACEMENT, NOT AN INTENT PARAMETER, and the difference is a
      // flag day — adding a parameter to an existing verb makes an old host
      // answer bad_params after the version handshake already agreed. `host`
      // has always travelled beside the intent; a tag is the same kind of
      // statement, about where rather than about what to do.
      properties.tag = {
        type: 'string',
        description:
          'Pick a kind of machine rather than a named one — "macos", "linux". A permanent host is used if ' +
          'one carries the tag; if only a temporary host does, you are told its name instead of sent there.',
      };
      // THE OPERATING NOTE, ON THE TOOLS THAT NEED ONE. `initialize`
      // instructions are the contract; these are the reminders at the point of
      // use, because a model that read the preamble twenty tool calls ago is
      // not reliably still holding it.
      /** @type {Record<string, string>} */
      const notes = {
        start: `You own what you start. Stop it when you have what you came for, or after about ${budgetMinutes} minutes — nothing here will tell you it has finished.`,
        resume: 'Resuming makes the session yours to stop in this conversation, the same as starting one.',
        stop: 'Only sessions you started here. Anything else belongs to somebody who is probably still using it.',
        peek: 'How you find out whether work is done. There is no completion signal; reading the pane is the signal.',
      };
      const description = [OVERRIDE[verb]?.description || def.summary || verb, notes[verb]].filter(Boolean).join(' ');

      return {
        name: `fleet_${verb}`,
        description,
        inputSchema: {
          type: 'object',
          properties,
          ...(required.length ? { required } : {}),
          additionalProperties: false,
        },
        verb,
        mutating: Boolean(def.mutating),
      };
    });

  for (const alias of aliasesFor(maxWaitSeconds)) {
    const base = tools.find((t) => t.verb === alias.verb);
    // Only if the verb it aliases is actually exposed — otherwise a denied
    // verb would come back through the side door under another name.
    if (!base) continue;
    /** @type {Record<string, any>} */
    const properties = alias.schema
      ? { ...alias.schema, host: base.inputSchema.properties.host }
      : { ...base.inputSchema.properties };
    for (const gone of alias.omit || []) delete properties[gone];
    tools.push({
      name: alias.name,
      description: alias.description,
      inputSchema: {
        type: 'object',
        properties,
        required: alias.requires || ['name'],
        additionalProperties: false,
      },
      verb: alias.verb,
      mutating: base.mutating,
      local: Boolean(alias.local),
    });
  }

  // AFTER THE ALIASES, and that ordering is the whole of it. An alias copies
  // the base tool's properties, so narrowing the base first hands the alias the
  // narrowed set — which silently took `name` off fleet_read_log, the one
  // parameter it cannot work without. Caught by a test that lists the tools and
  // reads their schemas, which is what a client does.
  for (const tool of tools) {
    for (const gone of OVERRIDE[tool.verb]?.omit || []) {
      if (tool.name === `fleet_${tool.verb}`) delete tool.inputSchema.properties[gone];
    }
  }

  return tools;
}
