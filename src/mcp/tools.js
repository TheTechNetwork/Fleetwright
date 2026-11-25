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
/**
 * Verbs only the coordinator sends. See the filter in toolsFor. `forgetperson`
 * is sent when somebody is removed from the fleet (core.js #forgetOnBoxes),
 * and `vmlogin` when a machine from a pool asks for its owner's Claude login
 * (core.js #vmClaude).
 */
export const COORDINATOR_ONLY = Object.freeze(['mint', 'forgetperson', 'vmlogin']);

/** @type {string[]} */
export const DEFAULT_DENY = ([
  // `reboot` ends every session on the box. `upgrade` is system packages and
  // can demand a reboot to finish. `restore` un-bins somebody else's work.
  //
  // `update` USED TO BE HERE AND IS NOT ANY MORE, and the reason is a design
  // decision this project already made and wrote down. The refusal lumped it
  // in as "restarts machines", which is true of reboot and false of this:
  // fleetwright.service sets KillMode=process specifically so restarting the
  // service does NOT reap the tmux server holding every session. That comment
  // calls itself load-bearing and names the outage that taught it.
  //
  // So `update` pulls this project's code and restarts its own service without
  // ending anybody's work — and withholding it left a beta tester with a host
  // two releases behind, refusing verbs, whose named fix required a shell the
  // product does not provide. A dead end rather than a policy.
  'reboot', 'upgrade', 'restore',
  // Who a box takes its reboots from. An agent acts on a delegation, and a box
  // refuses `pinadmin` on one whatever this list says: only a pinned admin's
  // own signature changes the pins (src/fleet/host/pinned-admins.js).
  'pinadmin',
  'connect', 'link', 'unlink', 'renew', 'answer',
  // A token that is a person's whole Claude subscription for a year. Made for
  // a phone to keep with the minter; an agent has no key to seal it to and no
  // business asking.
  'setuptoken',
  // ADDING A HYPERVISOR takes an admin sign-in sealed on a phone to the
  // machine that runs it. An agent has no key to seal it to, and bringing a
  // pool into the fleet is not something to reach for unasked.
  'xosetup',
  // A POOL'S PAGE FROM AWAY: the look comes back sealed to a key on the
  // phone, which an agent has no use for, and an action on somebody's pool
  // is the page's to offer with its confirmation, not a tool's.
  'xolook', 'xoact',
  // NOT `forget`, ANY MORE. It was withheld as "destroys a conversation that
  // cannot be recovered", and that stopped being true when the seven-day
  // recycle bin shipped — `forget` is now the RECOVERABLE one and `purge` is
  // not. Withholding it left both beta testers unable to clean up after
  // themselves: twelve stale sessions in one fleet, growing every visit, and
  // the list screen they made unreadable is the top complaint in both reports.
  //
  // Scoped exactly as `stop` was rehabilitated: only sessions this
  // conversation started. An agent that could forget anything would eventually
  // forget somebody's work because a name looked familiar; an agent that can
  // clear up after itself is just tidy.
  'purge',
  // THE WORKSPACE'S DESTRUCTIVE HALF. Browsing and reading are exposed —
  // collecting what a job produced is the case this server exists for. Writing,
  // copying and deleting are not, by the same rule as the rest of this list:
  // it is a policy about what an agent reaches for unasked, not a lock. An
  // operator who wants them says so with FLEETWRIGHT_MCP_ALLOW.
  //
  // `deletefile` is the sharpest of the three and the reason the line is drawn
  // here rather than after it: `forget` is recoverable for seven days and this
  // is not recoverable at all.
  'writefile', 'copyfile', 'deletefile',
  // WHAT WORK AIMED AT A TAG FINDS, which is the fleet's routing table.
  //
  // `sandbox` is NOT here and this is, which looks inconsistent and is not. The
  // variant decides what the NEXT session on one box gets — a bigger image, a
  // browser in it — and the ask was explicitly that an agent be able to choose
  // it. Nothing already running changes and nothing lands anywhere new.
  //
  // A label changes where OTHER PEOPLE'S work goes. An agent that adds `gpu` to
  // a box with no GPU has silently redirected somebody else's next session to a
  // machine that cannot do the job, and the misroute looks like the scheduler
  // being wrong. That is the "decided on somebody's behalf" shape `answer` is
  // withheld for, and it is a policy question rather than a permission one.
  //
  // READING IS NOT LOST. `health` is exposed and carries `labels`, so an agent
  // deciding where to aim its own work can still see what each box carries —
  // it just cannot change what everybody else's work matches.
  //
  // An operator who wants it says so with FLEETWRIGHT_MCP_ALLOW, like the three
  // above.
  'labels',

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
      'Wait for a session to finish. Returns as soon as it has come back to its prompt after working, ' +
      'needs a person, has ended, has errored, or the wait runs out — whichever comes first. Use this after ' +
      'fleet_start rather than calling fleet_peek in a loop. On a connection that caps a single wait it ' +
      'says so and asks you to call again, which is not a failure.',
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
    // THE FIRST TOOL WHOSE SUBJECT IS THE COORDINATOR, not a host, and that is
    // worth saying out loud because everything else here is generated from the
    // verb registry on purpose.
    //
    // `/api/events` is not a verb and must not become one: a verb is something
    // a HOST is asked to do, and this is the coordinator's own record of what
    // happened across the fleet. Inventing a verb for it would put a question
    // no host can answer into the protocol every host validates.
    //
    // So it goes through the same `local: true` door `fleet_await` uses — a
    // tool this server answers itself — and openapi.json stays the contract
    // rather than a document with a route in it that no client can reach.
    //
    // WHY AN AGENT WANTS IT. An agent picking work back up has exactly the
    // problem push was built for: something happened while it was not looking,
    // and `list` shows the state now rather than what changed. A session that
    // errored and was cleaned up is invisible to every other tool here.
    name: 'fleet_events',
    verb: null,
    description:
      'What happened across the fleet recently — sessions that ended, errored or asked for input, hosts ' +
      'that joined or were revoked. Use this to pick up work after being away: `fleet_list` shows the ' +
      'state now, and this shows what changed to get there. Oldest first.',
    schema: {},
    requires: [],
    local: true,
    coordinator: '/api/events',
  },
  {
    // THE ORGANIZATION (docs/members.md), and for the reason `fleet_events`
    // is here and not a verb: who the fleet's members are is the fleet's own
    // record, and no host can answer it. Two tools, a read and a write, on
    // the same route the phones use.
    name: 'fleet_members',
    verb: null,
    description:
      'The organization: every member of the fleet, each a person or an AI agent, with its role, who it ' +
      'reports to, the kinds of work it takes and where it runs. Read this to choose who a piece of work ' +
      'belongs to, then pass a member’s id as `member` to fleet_start. It also says which members you may ' +
      'start a session as.',
    schema: {},
    requires: [],
    local: true,
    coordinator: '/api/members',
  },
  {
    // A WRITE, and the only coordinator tool that is one. It changes the
    // RECORD: a name, a role, a place in the tree, instructions. Who may sign
    // a member in, or start a session as one, is custody, which the minter
    // holds and a person files from their own phone or the signing page with
    // their own sign-in inside. An MCP client holds no such thing, so nothing
    // here can reach a vault, and the description says so.
    //
    // NOR A BUDGET. `budgetUsdMonth` was a field here, and it is what a start
    // past it waits on a person for (docs/budgets.md): the tools an agent
    // holds do not include the one that says a person looked.
    name: 'fleet_member',
    verb: null,
    description:
      'Add a member to the organization, change one, or remove one. Give `id` and the fields to set; a field ' +
      'you leave out keeps its value. An admin may write any member, and a manager the members of their own ' +
      'team. This changes the record only: it holds no credential, and who may sign the member in or start a ' +
      'session as it (custody) is filed by a person from the app or the signing page. It does not set a ' +
      'budget either: a person sets one in the app, and fleet_budgets shows it.',
    schema: {
      id: { type: 'string', description: 'The member’s id: lowercase letters, digits and hyphens, at most 40. Naming one that does not exist adds it.' },
      remove: { type: 'boolean', description: 'Remove this member. Refused while anybody reports to it.' },
      markdown: { type: 'string', description: 'The member as its markdown file (front matter, then instructions), instead of fields. What fleet_members prints with `as: "files"` is this shape.' },
      name: { type: 'string', description: 'What a screen shows. Required for a new member.' },
      kind: { type: 'string', enum: ['person', 'agent'], description: 'Required for a new member, and never changed after.' },
      email: { type: 'string', description: 'A person member’s fleet address. An agent has none.' },
      role: { type: 'string', description: 'A label, like "software engineer". Required for a new member. It gives no rights.' },
      title: { type: 'string', description: 'A longer label.' },
      reportsTo: { type: 'string', description: 'Another member’s id, or an empty string for nobody. Who manages whom comes from this.' },
      description: { type: 'string', description: 'What this member is for, at most 300 characters.' },
      workTypes: { type: 'array', items: { type: 'string' }, description: 'The kinds of work it takes, as short lowercase names: "backend", "code-review".' },
      instructions: { type: 'string', description: 'Markdown the member’s sessions open with, before the task. At most 4 KiB.' },
      model: { type: 'string', description: 'The model its Claude Code engine runs, when not the default.' },
      engines: {
        type: 'array',
        items: { type: 'string' },
        description:
          'What runs the member, in the order to try: each "claude-code", "codex" or "opencode", with a model after "=" ' +
          '("codex=gpt-5.1-codex"; opencode needs one, written "opencode=github-copilot/<model>"). Up to three, each once. ' +
          'A session starts on the first that its machine runs, and at an account’s limit the next one continues from a ' +
          'handoff note in the workspace. Each runs on the member’s own sign-in of its kind, kept in its vault. ' +
          'An opencode model written "openrouter/<model>" or "vercel/<model>" bills an API key kept in the ' +
          'member’s vault, by the token, and no budget here counts it: a start on a member with one waits for ' +
          'an approval unless an admin turned that off (fleet_budgets), and it goes only to a machine whose ' +
          'operator turned that provider on (fleet_health).',
      },
      tag: { type: 'string', description: 'The host tag its sessions go to when the person starting one names no machine.' },
    },
    requires: ['id'],
    local: true,
    coordinator: '/api/members',
    mutating: true,
  },
  {
    // WHAT MEMBERS HAVE SPENT, AND THE APPROVALS A START WAITS ON
    // (docs/budgets.md). READ ONLY, BOTH OF THEM, AND ON PURPOSE: an approval
    // exists so that a person looks, and the tools an agent holds do not
    // include the one that says a person looked. Nor the one that changes
    // what needs approval. Both are a phone's.
    name: 'fleet_budgets',
    verb: null,
    description:
      'What each member you may see has spent this month against its budget, in dollars at API prices as ' +
      'each session counted its own cost, and what this fleet does when a budget is passed: nothing, ask ' +
      'for approval, or refuse. Also whether a session that skips permission prompts, or a kind of work, ' +
      'needs approval first. "At least" means the fleet could not count all of it, so the real figure is ' +
      'higher: a session reported no cost, or more at once than is counted, or a start got no answer from ' +
      'its machine. The sentence says which. ' +
      'A start that needs approval is refused with the approval’s id; a person who manages that member ' +
      'answers it on their phone, and the same start then goes through.',
    schema: {},
    requires: [],
    local: true,
    coordinator: '/api/budgets',
  },
  {
    name: 'fleet_approvals',
    verb: null,
    description:
      'The approvals you asked for and the ones waiting on you: who wants to start a session as which ' +
      'member, why it needs approval, what the session would be told, and where it stands. An approval is ' +
      'for those words: a start that says something else, or a task whose brief changed since, needs a new ' +
      'one. This tool does not answer one. An approval is a person’s to give, from the app, so tell the ' +
      'person who can and start again once it is given.',
    schema: {},
    requires: [],
    local: true,
    coordinator: '/api/approvals',
  },
  {
    // WHICH MEMBER A TASK GOES TO (docs/routing.md): the fleet's mode and its
    // rules by kind of work. Read by anybody; written by an admin with the
    // tool below, the split fleet_members and fleet_member have.
    name: 'fleet_routing',
    verb: null,
    description:
      'How the fleet chooses a member for a task that has none: its mode (off, manual or auto), its rules by ' +
      'kind of work, and whether a pick among several members can be a model’s. The order is fixed: a task ' +
      'somebody was given is never moved; then the rule for its kind of work; then the only member who takes ' +
      'it; then a pick among several, by the model in auto or by a person; and only among members the person ' +
      'asking could have assigned it to by hand.',
    schema: {},
    requires: [],
    local: true,
    coordinator: '/api/routing',
  },
  {
    name: 'fleet_set_routing',
    verb: null,
    description:
      'Change how the fleet routes tasks. A fleet admin only. `mode` is off, manual or auto; `rules` replaces ' +
      'the whole list, each a kind of work and the member it goes to, one member a kind. Either may be left ' +
      'out to keep what it is. This moves no task that already has a member.',
    schema: {
      mode: { type: 'string', enum: ['off', 'manual', 'auto'], description: 'off routes nothing; manual routes by the rules and asks a person to pick among several members; auto lets the fleet’s model pick where it has one.' },
      rules: {
        type: 'array',
        maxItems: 40,
        items: { type: 'string' },
        description: 'Every rule, each written "kind-of-work=member-id", like "backend=debbie". Replaces the list; an empty list removes every rule.',
      },
    },
    requires: [],
    local: true,
    coordinator: '/api/routing',
    mutating: true,
  },
  {
    // THE FLEET'S TASKS (docs/tasks.md), on the route the phones use: the
    // record above sessions, which is the fleet's own and no host's.
    name: 'fleet_tasks',
    verb: null,
    description:
      'The fleet’s tasks that you may see: each a piece of work with a brief, one assignee, a branch, the ' +
      'session working on it now, and the result when one came back. With `id`, one task in full: its ' +
      'brief, its result as the session wrote it, and every time it changed hands. A result is the ' +
      'session’s own account, and a branch is what the session was told: nothing here checked either.',
    schema: {
      id: { type: 'string', description: 'One task, by id, like t12. Leave out for the list.' },
      state: { type: 'string', enum: ['open', 'working', 'returned', 'done', 'cancelled'], description: 'Only the tasks in this state. `returned` are the ones waiting on a judgement.' },
    },
    requires: [],
    local: true,
    coordinator: '/api/tasks',
  },
  {
    // A WRITE to the fleet's own record, like fleet_member. It starts
    // nothing: a session on a task is fleet_start with `taskId`, or
    // fleet_delegate, and is a member start a custodian signs.
    name: 'fleet_task',
    verb: null,
    description:
      'Make a task, change one, hand it to another member, or act on one. With no `id` it makes a task from ' +
      '`title` and `brief`. With `id` and fields it changes them; a new `assignee` is a handoff and is ' +
      'refused while a session is working on the task. With `id` and `action` it releases the lock, accepts ' +
      'a result that came back, reopens the task with a `note` the next session is told, or cancels it. ' +
      '`action: "route"` asks the fleet which member an unassigned task should go to (fleet_routing says ' +
      'how it decides); with `assignee` as well it is your answer to that question. ' +
      'This starts and stops no session.',
    schema: {
      id: { type: 'string', description: 'The task to change or act on, like t12. Leave out to make a new one.' },
      title: { type: 'string', description: 'One line that says what it is. Required for a new task.' },
      brief: { type: 'string', description: 'What to do, where, and what to hand back. Required for a new task, and all its session gets: at most 2400 bytes.' },
      assignee: { type: 'string', description: 'A member’s id (fleet_members lists them), or an empty string for nobody. They must be on your team or a member you may start as.' },
      workType: { type: 'string', description: 'The kind of work, as a short lowercase name a member’s workTypes use.' },
      repo: { type: 'string', description: 'The repository the work is in, written owner/repo.' },
      parent: { type: 'string', description: 'For a new task: the task it is delegated from.' },
      action: { type: 'string', enum: ['release', 'accept', 'reopen', 'cancel', 'route'], description: 'What to do to the task named by `id`.' },
      routing: { type: 'string', enum: ['auto', 'manual', 'off', ''], description: 'This task’s own routing, whatever the fleet’s is: `manual` routes it by the rules and asks a person to pick among several members, `auto` lets the fleet’s model pick where it has one, `off` leaves it unassigned. An empty string follows the fleet’s setting again.' },
      note: { type: 'string', description: 'Why: with a new `assignee`, the handoff’s note; with `reopen`, what the next session is told (required). At most 300 bytes.' },
    },
    requires: [],
    local: true,
    coordinator: '/api/tasks',
    mutating: true,
  },
  {
    // THE WHOLE LOOP AS ONE TOOL (docs/tasks.md, "Delegating"): make the
    // task, start its assignee on it, wait, and answer with what came back.
    // Offered only where `start` is, because it starts a session.
    name: 'fleet_delegate',
    verb: null,
    description:
      'Hand a whole piece of work to another member and get the result back. With no `to`, the fleet’s routing ' +
      'chooses the member, and when a person has to choose it says who is being asked and starts nothing. ' +
      'It makes a task from `to`, ' +
      '`title` and `brief`, starts a session on it as that member, on the member’s own sign-ins and ' +
      'machine, waits for it to stop, and answers with the result packet: DONE, BLOCKED or FAILED, what the ' +
      'session wrote, the branch it was told and where it ran. THE BRIEF IS ALL THE OTHER MEMBER GETS: ' +
      'nothing of this conversation travels, so say what to do, where, and what to hand back. If the wait ' +
      'runs out the work is still going: call again with `task` set to the id you were given. You must be ' +
      'allowed to start a session as the member. The session is yours to stop with fleet_stop once you have ' +
      'the result, and the task is accepted or reopened with fleet_task.',
    schema: {
      to: { type: 'string', description: 'The member to hand the work to, by id (fleet_members lists them and the work each takes). Leave out to let the fleet’s routing choose among the members you may hand work to.' },
      routing: { type: 'string', enum: ['auto', 'manual'], description: 'With no `to`: how this one task is routed, whatever the fleet’s setting is. Left out, the fleet’s setting decides, and a fleet whose routing is off chooses nobody.' },
      title: { type: 'string', description: 'One line that says what the work is.' },
      brief: { type: 'string', description: 'What to do, where, and what to hand back, written for somebody who has seen none of this conversation. At most 2400 bytes.' },
      workType: { type: 'string', description: 'The kind of work, as a short lowercase name.' },
      repo: { type: 'string', description: 'The repository the work is in, written owner/repo.' },
      parent: { type: 'string', description: 'The task you are working on yourself, when this is a part of it.' },
      task: { type: 'string', description: 'Instead of all the above: a task you delegated earlier, by id, to keep waiting for.' },
      seconds: {
        type: 'integer',
        minimum: 5,
        maximum: maxWaitSeconds,
        description:
          maxWaitSeconds < 900
            ? `How long to wait for the result. This connection caps a single wait at ${maxWaitSeconds}s and then says so; call again with \`task\` to keep waiting.`
            : 'How long to wait for the result before saying it is still being worked on.',
      },
    },
    requires: [],
    local: true,
    coordinator: '/api/tasks',
    mutating: true,
    needs: 'start',
  },
  {
    name: 'fleet_read_log',
    verb: 'logs',
    description:
      "Read a session's console output — everything it printed, not just what is on screen now. " +
      'READ IT BEFORE YOU STOP THE SESSION: the output lives in the container, so stopping one throws it ' +
      'away and this answers "no container and no pane". `peek` shows the live pane instead, already ' +
      'rendered; this is the raw stream and may carry terminal escapes.',
    // The session half only. `service` is a different question and has its own
    // tool; offering both here would rebuild the ambiguity this exists to end.
    omit: ['service', 'machine'],
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
      'Or `service: boot`: what a Proxmox VE machine this host made printed on its console while it booted, ' +
      'for one that never joined and cannot be reached; without `machine` it lists them. ' +
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
      // A value with exactly one correct shape says so, so an agent sends an
      // `owner/repo` rather than a URL and learns nothing by being refused.
      if (spec.pattern instanceof RegExp) out.pattern = spec.pattern.source;
  }
  // THE PARAMETER'S OWN WORDS, WHEN IT HAS ANY. A `text` parameter arrived
  // here as `{type: 'string', maxLength: 500}` and nothing else — so an agent
  // saw `brief`, reasonably read it as the task to run, and got a session
  // sitting at an empty prompt. The protocol has always said "not passed to
  // the model and not run"; it said it in a comment the agent never sees.
  if (typeof spec.describe === 'string' && spec.describe) out.description = spec.describe;
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
 * @returns {Array<{ name: string, description: string, inputSchema: any, verb: string|null, mutating: boolean, local?: boolean, coordinator?: string }>}
 */
export function toolsFor({ allow = null, deny = DEFAULT_DENY, budgetMinutes = 15, maxWaitSeconds = 900 } = {}) {
  const extra = new Set(allow || []);
  // `verb` is null on a COORDINATOR tool, whose subject is the fleet's own
  // record rather than a host — see fleet_events. `coordinator` is the route it
  // reads, and its presence is what the server dispatches on.
  /** @type {Array<{ name: string, description: string, inputSchema: any, verb: string|null, mutating: boolean, local?: boolean, coordinator?: string }>} */
  const tools = Object.entries(VERBS)
    // NOT A TOOL AT ALL, not merely withheld: `mint` is sent by the coordinator
    // for a runner and refused from any caller (core.js dispatch), so offering
    // it — even behind `allow` — would be a tool that can only fail.
    .filter(([verb]) => !COORDINATOR_ONLY.includes(verb))
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
          'WHERE NEW WORK RUNS — it does not filter what you are shown. Pick a kind of machine rather than ' +
          'a named one ("macos", "linux"): a permanent host is used if one carries the tag, and if only a ' +
          'temporary host does you are told its name instead of being sent there. On a read like `list` it ' +
          'changes nothing, because reads fan out across the fleet.',
      };
      // THE OPERATING NOTE, ON THE TOOLS THAT NEED ONE. `initialize`
      // instructions are the contract; these are the reminders at the point of
      // use, because a model that read the preamble twenty tool calls ago is
      // not reliably still holding it.
      /** @type {Record<string, string>} */
      const notes = {
        start: `You own what you start. Stop it when you have what you came for, or after about ${budgetMinutes} minutes — nothing here will tell you it has finished.`,
        resume: 'Resuming makes the session yours to stop in this conversation, the same as starting one.',
        update: 'Pulls this project\'s code on one host and can restart its services. Sessions SURVIVE that restart — fleetwright keeps the tmux server outside its own cgroup for exactly this reason. Use it when a host refuses a verb because it is behind.',
        forget: 'Only sessions you started here. Recoverable for seven days — `restore` brings one back — which is why this is offered and `purge` is not.',
        stop: 'Only sessions you started here. Anything else belongs to somebody who is probably still using it. Collect the output with fleet_read_log FIRST — stopping a session throws its console output away.',
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
    // A COORDINATOR TOOL HAS NO BASE VERB, because its subject is not a host.
    // It carries no `host` parameter for the same reason: naming one would ask
    // the fleet to route a question the fleet itself answers.
    if (alias.coordinator) {
      if (deny.includes(alias.name.replace(/^fleet_/, '')) && !extra.has(alias.name.replace(/^fleet_/, ''))) continue;
      // A coordinator tool that also asks a host for something is offered
      // only where that verb is: fleet_delegate starts a session.
      if (alias.needs && !tools.some((t) => t.verb === alias.needs)) continue;
      tools.push({
        name: alias.name,
        description: alias.description,
        inputSchema: { type: 'object', properties: { ...alias.schema }, ...(alias.requires?.length ? { required: alias.requires } : {}), additionalProperties: false },
        verb: null,
        mutating: Boolean(alias.mutating),
        local: true,
        coordinator: alias.coordinator,
      });
      continue;
    }
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
    // `tool.verb` is null on a coordinator tool, and OVERRIDE is keyed by verb.
    if (!tool.verb) continue;
    for (const gone of OVERRIDE[tool.verb]?.omit || []) {
      if (tool.name === `fleet_${tool.verb}`) delete tool.inputSchema.properties[gone];
    }
  }

  return tools;
}
