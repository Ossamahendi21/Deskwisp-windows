// Deskwisp Mail's settings for mail-own.test.ts, set before anything reads them (imported first).
process.env.DESKWISP_MAIL_DOMAIN = "bots.deskwisp.test";
process.env.RESEND_API_KEY = "re_test_key";
process.env.DESKWISP_MAIL_INBOUND_SECRET = "inbound-secret-for-tests-0123456789abcdef";
delete process.env.AGENTMAIL_API_KEY;
delete process.env.AGENTPHONE_API_KEY;
