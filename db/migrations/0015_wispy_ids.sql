-- Main bots made before Deskwisp had ids of their own ("wispy", "wispy-2"…) get Wispy ids ("wispy",
-- or the next one free when a workspace's Wispy already has it), everywhere the cloud keeps them: the
-- state and its backups (bots, chats "bot:…", threads, usage), chat messages, what waited for the PC,
-- metered use, provider objects, phone lines and plan inboxes, and Deskwisp Mail's inbox details.
-- lib/bot-ids.ts does the same as a state loads in the app, choosing the ids the same way.
-- Run as deskwisp_app after 0014 (cloud/db.ts migrate() does it at start). Safe to run again.

BEGIN;

DO $$
DECLARE
  u record;
  o text;
  olds text[];
  news text[];
  taken text[];
  target text;
  n int;
  i int;
  pat text;
BEGIN
  FOR u IN
    SELECT s.user_id, s.state FROM deskwisp.app_state s
    WHERE s.state::text ~ '\mwispy\M'
       OR EXISTS (SELECT 1 FROM deskwisp.chat_messages m WHERE m.user_id = s.user_id AND (m.chat_id ~ '\mwispy\M' OR m.json::text ~ '\mwispy\M'))
       OR EXISTS (SELECT 1 FROM deskwisp.cloud_objects o WHERE o.user_id = s.user_id AND o.bot_id ~ '^wispy(-[0-9]+)?$')
       OR EXISTS (SELECT 1 FROM deskwisp.phone_lines p WHERE p.user_id = s.user_id AND p.bot_id ~ '^wispy(-[0-9]+)?$')
       OR EXISTS (SELECT 1 FROM deskwisp.mail_inboxes x WHERE x.user_id = s.user_id AND x.bot_id ~ '^wispy(-[0-9]+)?$')
  LOOP
    SELECT coalesce(array_agg(b->>'id'), '{}') INTO taken
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(u.state->'bots') = 'array' THEN u.state->'bots' ELSE '[]'::jsonb END) AS b
    WHERE jsonb_typeof(b->'id') = 'string';
    olds := ARRAY(SELECT t FROM unnest(taken) AS t WHERE t ~ '^wispy(-[0-9]+)?$' ORDER BY length(t), t);
    news := '{}';
    IF cardinality(olds) > 0 THEN
      -- As lib/bot-ids.ts: in order, each to the first Wispy id nobody has.
      FOREACH o IN ARRAY olds LOOP
        target := 'wispy';
        n := 2;
        WHILE target = ANY (taken) LOOP
          target := 'wispy-' || n;
          n := n + 1;
        END LOOP;
        taken := taken || target;
        news := news || target;
      END LOOP;
    ELSE
      -- The app renamed its state already: what's left elsewhere follows its Wispy, number for number.
      olds := ARRAY(
        SELECT DISTINCT t FROM (
          SELECT bot_id AS t FROM deskwisp.cloud_objects WHERE user_id = u.user_id
          UNION SELECT bot_id FROM deskwisp.phone_lines WHERE user_id = u.user_id
          UNION SELECT bot_id FROM deskwisp.mail_inboxes WHERE user_id = u.user_id
          UNION SELECT (regexp_matches(chat_id, 'wispy(?:-[0-9]+)?'))[1] FROM deskwisp.chat_messages WHERE user_id = u.user_id
        ) AS x WHERE t ~ '^wispy(-[0-9]+)?$' ORDER BY 1);
      news := ARRAY(SELECT regexp_replace(t, '^wispy', 'wispy') FROM unnest(olds) WITH ORDINALITY AS o(t, k) ORDER BY k);
    END IF;

    -- Longest first, so "wispy-2" is done before "wispy" (whose pattern skips "wispy-2" anyway).
    FOR i IN REVERSE cardinality(olds)..1 LOOP
      pat := '\m' || olds[i] || '\M(?!-[0-9])';
      UPDATE deskwisp.app_state SET state = regexp_replace(state::text, pat, news[i], 'g')::jsonb
        WHERE user_id = u.user_id AND state::text ~ pat;
      UPDATE deskwisp.app_state_backups SET state = regexp_replace(state::text, pat, news[i], 'g')::jsonb
        WHERE user_id = u.user_id AND state::text ~ pat;
      UPDATE deskwisp.chat_messages
        SET chat_id = regexp_replace(chat_id, pat, news[i], 'g'),
            json = CASE WHEN json IS NULL THEN NULL ELSE regexp_replace(json::text, pat, news[i], 'g')::jsonb END
        WHERE user_id = u.user_id AND (chat_id ~ pat OR json::text ~ pat);
      UPDATE deskwisp.cloud_pending SET payload = regexp_replace(payload::text, pat, news[i], 'g')::jsonb
        WHERE user_id = u.user_id AND payload::text ~ pat;
      UPDATE deskwisp.cloud_usage SET detail = regexp_replace(detail::text, pat, news[i], 'g')::jsonb
        WHERE user_id = u.user_id AND detail IS NOT NULL AND detail::text ~ pat;
      UPDATE deskwisp.cloud_objects SET bot_id = news[i] WHERE user_id = u.user_id AND bot_id = olds[i];
      UPDATE deskwisp.phone_lines SET bot_id = news[i] WHERE user_id = u.user_id AND bot_id = olds[i];
      UPDATE deskwisp.mail_inboxes SET bot_id = news[i] WHERE user_id = u.user_id AND bot_id = olds[i];
    END LOOP;
  END LOOP;
END
$$;

-- Deskwisp Mail's inboxes say which bot they were made for (only as a note: nothing reads it back).
UPDATE deskwisp.mail_boxes
SET metadata = jsonb_set(metadata, '{deskwisp_bot}', to_jsonb(regexp_replace(metadata->>'deskwisp_bot', '^wispy', 'wispy')))
WHERE metadata->>'deskwisp_bot' ~ '^wispy(-[0-9]+)?$';

INSERT INTO deskwisp.schema_migrations (version) VALUES ('0015_wispy_ids') ON CONFLICT DO NOTHING;

COMMIT;
