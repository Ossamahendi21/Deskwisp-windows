import assert from "node:assert/strict";
import { test } from "node:test";
import { config } from "../config.ts";
import { mailDomain } from "../session.ts";

test("bots' addresses go on a domain only when one of your own is set", async () => {
  const was = process.env.DESKWISP_MAIL_DOMAIN;
  try {
    delete process.env.DESKWISP_MAIL_DOMAIN;
    assert.equal(config.mailDomain(), null, "unset: agentmail.to, and nothing is checked");
    assert.equal(await mailDomain(), null);
    process.env.DESKWISP_MAIL_DOMAIN = "agentmail.to";
    assert.equal(config.mailDomain(), null);
    process.env.DESKWISP_MAIL_DOMAIN = " Mail.Example.com ";
    assert.equal(config.mailDomain(), "mail.example.com");
  } finally {
    if (was === undefined) delete process.env.DESKWISP_MAIL_DOMAIN;
    else process.env.DESKWISP_MAIL_DOMAIN = was;
  }
});
