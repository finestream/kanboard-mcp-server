import test from "node:test";
import assert from "node:assert/strict";
import { parseCredentials, sha256hex } from "./credentials.ts";

const H_A1 = sha256hex("alice-client-1");
const H_A2 = sha256hex("alice-client-2");
const H_B = sha256hex("bob-client");

const FILE = `
# user    kanboard-user  token         bearer-hashes      emails
alice     alice          kb_tok_alice  ${H_A1},${H_A2}    Alice@Example.org,alice@other.example
bob       robert         kb_tok_bob    ${H_B}
carol     carol          kb_tok_carol  -                  carol@example.org   # by Access only
`;

test("credentials: the file parses into users with their Kanboard user, token, bearers and addresses", () => {
  const { credentials, problems } = parseCredentials(FILE);
  assert.deepEqual(problems, []);
  assert.equal(credentials.users.size, 3);
  const alice = credentials.users.get("alice")!;
  assert.equal(alice.kanboardUser, "alice");
  assert.equal(alice.token, "kb_tok_alice");
  assert.equal(alice.bearerHashes.length, 2);
  assert.deepEqual(alice.emails, ["alice@example.org", "alice@other.example"]);
  const bob = credentials.users.get("bob")!;
  assert.equal(bob.kanboardUser, "robert", "the Kanboard user may differ from the agent's name");
  assert.deepEqual(bob.emails, [], "a line of four fields has no e-mail address");
  assert.deepEqual(credentials.users.get("carol")!.bearerHashes, []);
});

test("credentials: a bearer is looked up by its hash; an unknown or empty bearer finds nobody", () => {
  const { credentials } = parseCredentials(FILE);
  assert.equal(credentials.byBearer("alice-client-2")?.user, "alice");
  assert.equal(credentials.byBearer("bob-client")?.user, "bob");
  assert.equal(credentials.byBearer("bob-client "), null);
  assert.equal(credentials.byBearer(""), null);
  assert.equal(credentials.byBearer(H_B), null, "the hash itself is not a bearer");
});

test("credentials: an address is looked up in any case; a user name is not an address", () => {
  const { credentials } = parseCredentials(FILE);
  assert.equal(credentials.byEmail("ALICE@OTHER.EXAMPLE")?.user, "alice");
  assert.equal(credentials.byEmail("carol@example.org")?.user, "carol");
  assert.equal(credentials.byEmail("bob@example.org"), null);
  assert.equal(credentials.byEmail("alice"), null);
  assert.equal(credentials.byEmail("-"), null);
});

test("credentials: duplicates, malformed hashes, a shared address, a field that is no address and a wrong field count are reported", () => {
  const { credentials, problems } = parseCredentials(`alice alice t ${H_A1} alice@example.org\nalice alice t -\nbob bob t ${H_A1} Alice@Example.org\ncarol carol t abc carol\ndave dave\neve eve t - eve@example.org extra\n`);
  assert.deepEqual(
    problems.map((p) => p.replace(/:.*/, "")),
    ["line 2", "line 3", "line 3", "line 4", "line 4", "line 5", "line 6"],
  );
  assert.match(problems[0], /appears twice/);
  assert.match(problems[1], /bearer hash already used by "alice"/);
  assert.match(problems[2], /e-mail address already used by "alice"/);
  assert.match(problems[3], /not a hex SHA-256/);
  assert.match(problems[4], /"carol" is not an e-mail address/);
  assert.match(problems[5], /4 or 5 fields/);
  assert.match(problems[6], /got 6/);
  assert.equal(credentials.byEmail("alice@example.org")?.user, "alice", "the first line keeps the address");
});
