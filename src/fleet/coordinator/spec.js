// The origin the committed openapi.json names.
//
// A FILE OF ITS OWN FOR ONE STRING, and the reason is a real outage rather
// than tidiness. It was `export const SPEC_ORIGIN` in worker/src/worker.js,
// and workerd treats EVERY named export of the entrypoint module as a Worker
// binding — only `default` and Durable Object classes may be exported. So the
// Worker failed to load:
//
//   service core:user:agent-fleet-coordinator: Uncaught TypeError:
//   Incorrect type for map entry 'SPEC_ORIGIN': the provided value is not of
//   type 'function or ExportedHandler'.
//
// It bundled, it typechecked, and 1158 tests passed. Only the job that boots
// the real runtime saw it — which is the job this repository added after an
// outage that existed only in workerd, and it has now paid for itself twice.
//
// It cannot live in coordinator/server.js either, which is where the Node
// coordinator would naturally keep it: worker.js importing that would drag
// `node:http` into the Worker bundle, which is what worker.yml's dry-run
// exists to refuse.
//
// Substituted at serve time by both coordinators, so the document names
// whoever is serving it rather than whoever wrote it — a fork's /openapi.json
// used to advertise our origin, and anything generated from it pointed at
// somebody else's fleet.
//
// Pinned to exactly one occurrence in openapi.json by test/openapi.test.js,
// because the substitution is a string replace rather than a parse and a
// second occurrence would be left behind pointing at us.
export const SPEC_ORIGIN = 'https://fleet.thetech.network';
