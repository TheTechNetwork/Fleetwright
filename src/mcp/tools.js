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
 * @param {{ allow?: string[]|null, deny?: string[], budgetMinutes?: number }} [opts]
 *   `allow` names verbs to expose beyond the safe set; null means the default.
 *   `budgetMinutes` is stated in the descriptions that need it — the lifecycle
 *   is the agent's to manage, so the numbers it manages against have to be in
 *   front of it rather than in a document somebody else read.
 * @returns {Array<{ name: string, description: string, inputSchema: object, verb: string, mutating: boolean }>}
 */
export function toolsFor({ allow = null, deny = DEFAULT_DENY, budgetMinutes = 15 } = {}) {
  const extra = new Set(allow || []);
  return Object.entries(VERBS)
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
      const description = [def.summary || verb, notes[verb]].filter(Boolean).join(' ');

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
}
