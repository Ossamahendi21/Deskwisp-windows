import assert from "node:assert/strict";
import { test } from "node:test";
import { lost } from "../db.ts";

test("a lost connection is told from a statement the database turned down", () => {
  assert.equal(lost(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })), true);
  assert.equal(lost(new Error("Connection terminated due to connection timeout")), true);
  assert.equal(lost(new Error("Connection terminated unexpectedly")), true);
  assert.equal(lost(Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" })), true);
  assert.equal(lost(Object.assign(new Error('duplicate key value violates unique constraint "x"'), { code: "23505" })), false);
  assert.equal(lost(Object.assign(new Error("syntax error"), { code: "42601" })), false);
  assert.equal(lost(undefined), false);
});
