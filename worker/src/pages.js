// The two pages a person reads with no credential: privacy, and what this is.
//
// SHARED BY TWO WORKERS, which is why they live here rather than beside a
// handler. The coordinator serves /privacy because two store listings point at
// it; the demo Worker serves both, because the demo Worker is the one that is
// SUPPOSED to be a public face. See docs/coordinator-deploy.md.
//
// WHAT THESE ARE NOT: a copy of docs/. Those are engineering essays, they
// belong in the repository next to the code they describe, and bundling them
// here would put a second copy on a different release cycle — which is exactly
// the failure a beta tester found when four documents gave four answers about
// the apps. Everything specific links to GitHub.
//
// The bar for a sentence being here: could it be wrong in six months without
// anybody noticing? If yes, it links out instead.

export const PRIVACY = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fleetwright — Privacy</title>
<style>
  :root { color-scheme: light dark; }
  body { max-width: 40rem; margin: 3rem auto; padding: 0 1.25rem;
         font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  h1 { font-size: 1.6rem; } h2 { font-size: 1.1rem; margin-top: 2rem; }
  code { font-size: 0.9em; }
</style></head><body>
<h1>Fleetwright — Privacy</h1>
<p><strong>There is no Fleetwright service.</strong> It is a client for a
coordinator you run yourself, there is no account to create here, and there is
no analytics, advertising or tracking of any kind.</p>

<p>Signing in uses <strong>your own Apple or Google account</strong>. Fleetwright
does not create one, does not store a password, and never sees one.</p>

<h2>Your email address</h2>
<p>When you sign in, Apple or Google confirms your email address to your
coordinator, which decides whether that address is allowed in and issues this
device a credential of its own. The address is shown in Settings so you can see
who the app is signed in as, and it is attached to the commands you send so your
coordinator's records say who did what.</p>
<p>It goes to your coordinator and nowhere else. Choose <em>Share My Email</em>
on iOS: a hidden relay address cannot be matched against the list of people your
coordinator allows, and signing in will be refused.</p>

<h2>What stays on your device</h2>
<p>The coordinator's address, the credential issued to this device, and the email
address you signed in with. The credential is held in the iOS Keychain or behind
an Android Keystore key that cannot be exported, and it is sent only to that
coordinator, as an <code>Authorization</code> header over HTTPS.</p>

<h2>What is sent to your coordinator</h2>
<ul>
  <li>The commands you issue — list, start, stop, resume a session.</li>
  <li>The email address you signed in with, so the commands are attributable.</li>
  <li>Your push notification token, if you enable notifications, so the
      coordinator can tell you when a session needs an answer.</li>
</ul>
<p>That coordinator is infrastructure you operate. Its logs and its data are
yours, and this app has no other destination.</p>

<h2>Third parties</h2>
<p>Two, and only for the two things that cannot be done without them: Apple or
Google confirm who you are when you sign in, and Apple or Google deliver a push
notification to your device. No advertising, no tracking, no analytics, and no
third-party SDKs beyond the sign-in components each platform provides.</p>
<p>Your coordinator is not a third party — it is infrastructure you operate.</p>

<h2>Deleting your data</h2>
<p>Deleting the app removes the credential, the coordinator address and the email
address from the device. Revoking the device from your coordinator — from another
signed-in device, or with the admin credential — stops it reaching the fleet at
all and takes its push registration with it.</p>

<h2>Source</h2>
<p>The app and the coordinator are open source:
<a href="https://github.com/TheTechNetwork/Fleetwright">github.com/TheTechNetwork/Fleetwright</a>.
Every claim on this page can be checked against the code.</p>
</body></html>`;

export const DOCS = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fleetwright</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 system-ui, -apple-system, sans-serif; margin: 0 auto; max-width: 44rem;
         padding: 3rem 1.25rem 6rem; background: Canvas; color: CanvasText; }
  h1 { font-size: 1.6rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.1rem; margin: 2.5rem 0 .5rem; }
  .lede { font-size: 1.1rem; color: color-mix(in srgb, CanvasText 75%, Canvas); margin: 0 0 2rem; }
  p, li { color: color-mix(in srgb, CanvasText 82%, Canvas); }
  code { font-size: .9em; }
  a { color: inherit; }
  .cards { display: grid; gap: .75rem; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); margin: 1rem 0; }
  .card { border: 1px solid color-mix(in srgb, CanvasText 15%, Canvas); border-radius: .6rem; padding: .9rem 1rem; }
  .card b { display: block; margin-bottom: .2rem; }
  .note { border-left: 3px solid color-mix(in srgb, CanvasText 25%, Canvas); padding-left: 1rem; margin: 1.5rem 0; }
  footer { margin-top: 3rem; font-size: .85rem; color: color-mix(in srgb, CanvasText 55%, Canvas); }
</style></head><body>

<h1>Fleetwright</h1>
<p class="lede">Your Claude Code sessions, on your own machines, from your phone.</p>

<p>You run the machines. Fleetwright gives you a list of what is running on them,
tells you when something is waiting on you, and lets you answer it without
finding a laptop.</p>

<h2>What you need</h2>
<div class="cards">
  <div class="card"><b>A machine you own</b>A Linux box, a spare laptop, a VM. It dials out — nothing is aimed at it, and it needs no open port.</div>
  <div class="card"><b>Your own Claude account</b>Sessions run as whoever starts them. Nobody borrows anybody else's.</div>
  <div class="card"><b>The app</b>iPhone or Android. Sign in with Apple or Google.</div>
</div>

<h2>What it does</h2>
<ul>
  <li>Start a session on any machine in your fleet — with a task, or idle — and see every session across all of them in one list.</li>
  <li>Get a notification when a session stops or is waiting for an answer — and answer it from the notification.</li>
  <li>Read what a session is doing, browse and edit the files it is working on, and stop it when it is done.</li>
  <li>Drive the fleet from Claude itself, over MCP.</li>
</ul>

<div class="note">
  <p><b>Fleetwright does not write a session's instructions.</b> You start one
  on a <em>task</em> — a file on the machine that runs it, chosen by name — and
  it comes up already working. Pick no task and it waits for you instead, and
  says so. Either way, what a session is told to do is decided on the machine,
  not by anything in between.</p>
</div>

<h2>What it does not do</h2>
<ul>
  <li><b>It is not a hosting service.</b> There is no server of ours in the middle holding your work. The coordinator you talk to is one you deploy.</li>
  <li><b>It never holds your Claude password.</b> Signing in happens with Apple, Google or Anthropic directly.</li>
  <li><b>A credential belongs to one device.</b> Lose a phone and you revoke that phone, not everything.</li>
</ul>

<h2>Getting started</h2>
<p>The install is one command on the machine, and the setup is ten steps end to
end. Both are in the repository, which is where they stay current:</p>
<ul>
  <li><a href="https://github.com/TheTechNetwork/Fleetwright/blob/main/docs/first-session.md">Fresh box to first session</a> — the ten steps</li>
  <li><a href="https://github.com/TheTechNetwork/Fleetwright/blob/main/README.md">README</a> — what this is and how it fits together</li>
  <li><a href="https://github.com/TheTechNetwork/Fleetwright/blob/main/docs/mcp.md">Driving it from Claude</a> — the MCP server</li>
  <li><a href="https://github.com/TheTechNetwork/Fleetwright/blob/main/docs/security.md">Security</a> — what each part can do, and what it cannot</li>
</ul>

<h2>How finished is it</h2>
<p>Honestly: in beta, and the repository says which parts are proven and how
that was established — including the ones that are not. That table is
<a href="https://github.com/TheTechNetwork/Fleetwright/blob/main/docs/app-parity.md">kept in one place on purpose</a>,
because four documents quietly disagreeing about it is a mistake this project
has already made once.</p>

<h2>Run your own coordinator</h2>
<p>The coordinator is a Cloudflare Worker. It is the only piece that is not on
your own hardware, and you deploy it to your own account — there is no tenancy
of ours to be in.</p>
<p><a href="https://deploy.workers.cloudflare.com/?url=https://github.com/TheTechNetwork/Fleetwright">
<img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare Workers" height="32"></a></p>
<p>One thing to check in the dialog that opens: the deploy command should be
<code>npm run deploy</code>. The Worker lives in <code>worker/</code> of a
repository that also holds everything that runs on your machines, so an offer
to configure the project automatically has looked at the wrong directory and
will configure the wrong thing — that command is the repository saying which
thing is the Worker. The repository the button makes is yours — updates reach
it when you merge ours in and push, and the
<a href="https://github.com/TheTechNetwork/Fleetwright/blob/main/docs/coordinator-deploy.md">deploy page</a>
says how. Prefer a terminal? The same page is five commands from clone to a
coordinator answering on a URL, with no copy to maintain.</p>
<p>The dialog asks up front for two values — a break-glass admin token, and
who may sign in. A coordinator that comes up with no way for anybody to
authenticate refuses every request and says so, naming both remedies; the
dialog's questions are how a button deploy starts life past that state. <a href="https://github.com/TheTechNetwork/Fleetwright/blob/main/docs/coordinator-deploy.md">The rest of the deploy</a>
is DNS and four secrets.</p>
<p><strong>Sign-in still works with the apps from the stores</strong> — you need no
Apple or Google setup of your own for it. What you cannot self-host is
<em>push</em>: a notification is addressed to one specific app, so waking these
apps needs our credentials. Your fleet works without it, and says so. A relay
that delivers notifications for coordinators that are not ours is planned, and
<a href="https://github.com/TheTechNetwork/Fleetwright/blob/main/docs/relay-terms.md">its terms are written down already</a> —
nothing about a notification is kept, and the only stored state is a rate-limit
counter.</p>

<footer>
  <a href="https://github.com/TheTechNetwork/Fleetwright">Source</a> ·
  <a href="/privacy">Privacy</a> ·
  <a href="https://github.com/TheTechNetwork/Fleetwright/blob/main/openapi.json">API</a>
</footer>
</body></html>`;
