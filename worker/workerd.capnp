# The coordinator under workerd, outside Cloudflare. Read by worker/Containerfile.
#
# THIS IS CONFIGURATION, NOT A SECOND IMPLEMENTATION. The module it loads is the
# bundle `wrangler deploy` ships; what differs from worker/wrangler.toml is only
# where the Durable Object keeps its SQLite (a directory, mounted as a volume)
# and how variables arrive (the process environment, every one of them). Two
# Cloudflare bindings have no counterpart and are deliberately absent — the
# ratelimit binding SIGNIN_RATE_LIMIT and the send_email binding EMAIL — and the
# code treats both as optional; see the Containerfile for what that costs.
#
# The variable list below is GENERATED from the code: every `env.FLEETWRIGHT_*`
# and `env.SENTRY_*` the Worker and the shared coordinator code read. Adding a
# variable to the code without adding it here means the container silently
# never sees it, which is the one failure this file can have.

using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "fleet", worker = .fleet),
    # Where the Durable Object's SQLite lives. /data is the VOLUME in the
    # Containerfile; the membership list, the device credentials and the event
    # ring are all in here, so this is the one path to back up.
    (name = "state", disk = (path = "/data", writable = true)),
  ],
  # Plain HTTP on 8787, on every interface of the container. TLS is the
  # proxy's job, and FLEETWRIGHT_PUBLIC_ORIGIN is what the proxy answers on.
  sockets = [ (name = "http", address = "0.0.0.0:8787", http = (), service = "fleet") ],
);

const fleet :Workerd.Worker = (
  modules = [ (name = "worker.mjs", esModule = embed "worker.mjs") ],
  # Both from worker/wrangler.toml, and they have to stay equal to it: the
  # date decides runtime behaviour, and nodejs_als is what lets the Sentry SDK
  # import node:async_hooks.
  compatibilityDate = "2026-01-15",
  compatibilityFlags = ["nodejs_als"],
  # One class, SQLite-backed, as `new_sqlite_classes = ["Fleet"]` in the
  # migrations. The uniqueKey names the namespace on disk; changing it is
  # starting a new fleet with an empty membership list.
  durableObjectNamespaces = [ (className = "Fleet", uniqueKey = "fleetwright-fleet-v1", enableSql = true) ],
  durableObjectStorage = (localDisk = "state"),
  bindings = [
    (name = "FLEET", durableObjectNamespace = "Fleet"),
    (name = "FLEETWRIGHT_ACTIONS_AUDIENCE", fromEnvironment = "FLEETWRIGHT_ACTIONS_AUDIENCE"),
    (name = "FLEETWRIGHT_ACTIONS_REPOS", fromEnvironment = "FLEETWRIGHT_ACTIONS_REPOS"),
    (name = "FLEETWRIGHT_ACTIONS_WORKFLOW", fromEnvironment = "FLEETWRIGHT_ACTIONS_WORKFLOW"),
    (name = "FLEETWRIGHT_API_TOKEN", fromEnvironment = "FLEETWRIGHT_API_TOKEN"),
    (name = "FLEETWRIGHT_APNS_BUNDLE_ID", fromEnvironment = "FLEETWRIGHT_APNS_BUNDLE_ID"),
    (name = "FLEETWRIGHT_APNS_SANDBOX", fromEnvironment = "FLEETWRIGHT_APNS_SANDBOX"),
    (name = "FLEETWRIGHT_APP_ANDROID", fromEnvironment = "FLEETWRIGHT_APP_ANDROID"),
    (name = "FLEETWRIGHT_APP_IOS", fromEnvironment = "FLEETWRIGHT_APP_IOS"),
    (name = "FLEETWRIGHT_AUTH_ALLOW", fromEnvironment = "FLEETWRIGHT_AUTH_ALLOW"),
    (name = "FLEETWRIGHT_AUTH_APPLE_SERVICE", fromEnvironment = "FLEETWRIGHT_AUTH_APPLE_SERVICE"),
    (name = "FLEETWRIGHT_AUTH_AUDIENCES", fromEnvironment = "FLEETWRIGHT_AUTH_AUDIENCES"),
    (name = "FLEETWRIGHT_AUTH_ISSUERS", fromEnvironment = "FLEETWRIGHT_AUTH_ISSUERS"),
    (name = "FLEETWRIGHT_CLOUDFLARE_CLIENT_ID", fromEnvironment = "FLEETWRIGHT_CLOUDFLARE_CLIENT_ID"),
    (name = "FLEETWRIGHT_CLOUDFLARE_CLIENT_SECRET", fromEnvironment = "FLEETWRIGHT_CLOUDFLARE_CLIENT_SECRET"),
    (name = "FLEETWRIGHT_CLOUDFLARE_SCOPES", fromEnvironment = "FLEETWRIGHT_CLOUDFLARE_SCOPES"),
    (name = "FLEETWRIGHT_DOCS_URL", fromEnvironment = "FLEETWRIGHT_DOCS_URL"),
    (name = "FLEETWRIGHT_FCM_SERVICE_ACCOUNT", fromEnvironment = "FLEETWRIGHT_FCM_SERVICE_ACCOUNT"),
    (name = "FLEETWRIGHT_GITHUB_CLIENT_ID", fromEnvironment = "FLEETWRIGHT_GITHUB_CLIENT_ID"),
    (name = "FLEETWRIGHT_GITHUB_CLIENT_SECRET", fromEnvironment = "FLEETWRIGHT_GITHUB_CLIENT_SECRET"),
    (name = "FLEETWRIGHT_INSTALL_URL", fromEnvironment = "FLEETWRIGHT_INSTALL_URL"),
    (name = "FLEETWRIGHT_INVITE_FROM", fromEnvironment = "FLEETWRIGHT_INVITE_FROM"),
    (name = "FLEETWRIGHT_NAME", fromEnvironment = "FLEETWRIGHT_NAME"),
    (name = "FLEETWRIGHT_PUBLIC_ORIGIN", fromEnvironment = "FLEETWRIGHT_PUBLIC_ORIGIN"),
    (name = "FLEETWRIGHT_PUSH", fromEnvironment = "FLEETWRIGHT_PUSH"),
    (name = "FLEETWRIGHT_RUNNER_REPO", fromEnvironment = "FLEETWRIGHT_RUNNER_REPO"),
    (name = "SENTRY_DSN", fromEnvironment = "SENTRY_DSN"),
    (name = "SENTRY_ENVIRONMENT", fromEnvironment = "SENTRY_ENVIRONMENT"),
    (name = "SENTRY_TRACES_SAMPLE_RATE", fromEnvironment = "SENTRY_TRACES_SAMPLE_RATE"),
  ],
);
