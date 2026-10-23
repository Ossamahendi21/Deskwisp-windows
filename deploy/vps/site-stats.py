#!/usr/bin/env python3
"""deskwisp.com's own counts, for every visitor whatever they answered about cookies: visitors, page
views, Windows downloads from the website and updates the app fetched, per day.

Read from Caddy's access log of the website (deploy/vps/deskwisp.caddy: /var/log/caddy/deskwisp-site.log,
kept 30 days). Only the totals are kept after that, in /var/lib/deskwisp/site-stats.csv: no addresses.
A visitor is one address and browser in a day; a download is one address getting the installer in a day
(a browser that fetches it in pieces counts once). Robots, link previews and scripts don't count.

  sudo deskwisp-site-stats            the last 30 days, and all-time totals
  sudo deskwisp-site-stats 90         the last 90 days
  deskwisp-site-stats --save          only saves today's totals (cron.daily runs it)
"""
import csv, glob, gzip, hashlib, json, os, re, sys
from collections import defaultdict
from datetime import datetime, timezone

LOGS = "/var/log/caddy/deskwisp-site*.log*"
KEPT = "/var/lib/deskwisp/site-stats.csv"
FIELDS = ["day", "visitors", "page_views", "downloads", "updates"]
ROBOT = re.compile(r"bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|discord|slack|curl|wget|python|go-http|java/|okhttp|headless|lighthouse|monitor|uptime|scan|fetch|http-client|node", re.I)
PAGE = re.compile(r"^/(privacy/|terms/)?(index\.html)?(\?.*)?$")
DOWNLOAD = re.compile(r"^/download/Deskwisp-Setup\.exe(\?.*)?$")
UPDATE = re.compile(r"^/download/win/Deskwisp-Setup-[^/]+\.exe(\?.*)?$")


def lines():
    for path in sorted(glob.glob(LOGS)):
        try:
            f = gzip.open(path, "rt", errors="replace") if path.endswith(".gz") else open(path, errors="replace")
        except OSError:
            continue
        with f:
            yield from f


def from_logs():
    seen = defaultdict(lambda: {"visitors": set(), "page_views": 0, "downloads": set(), "updates": set()})
    for line in lines():
        try:
            e = json.loads(line)
            req = e["request"]
        except (ValueError, KeyError, TypeError):
            continue
        if req.get("method") != "GET" or req.get("host", "deskwisp.com") not in ("deskwisp.com", "www.deskwisp.com"):
            continue
        status = e.get("status", 0)
        if status >= 400 or status in (301, 302, 308):
            continue
        ua = ((req.get("headers") or {}).get("User-Agent") or [""])[0]
        who = hashlib.sha256(f"{req.get('client_ip') or req.get('remote_ip')}|{ua}".encode()).hexdigest()[:16]
        day = datetime.fromtimestamp(e.get("ts", 0), timezone.utc).strftime("%Y-%m-%d")
        uri = req.get("uri", "")
        d = seen[day]
        # The app fetches its updates itself (not a browser), so those count whatever it calls itself.
        if UPDATE.match(uri):
            d["updates"].add(who)
            continue
        if not ua or ROBOT.search(ua):
            continue
        if PAGE.match(uri):
            d["visitors"].add(who)
            d["page_views"] += 1
        elif DOWNLOAD.match(uri):
            d["downloads"].add(who)
    return {day: {"visitors": len(d["visitors"]), "page_views": d["page_views"], "downloads": len(d["downloads"]), "updates": len(d["updates"])} for day, d in seen.items()}


def load():
    days = {}
    try:
        with open(KEPT, newline="") as f:
            for r in csv.DictReader(f):
                days[r["day"]] = {k: int(r[k]) for k in FIELDS[1:]}
    except (OSError, KeyError, ValueError):
        pass
    return days


def save(days):
    os.makedirs(os.path.dirname(KEPT), exist_ok=True)
    tmp = KEPT + ".new"
    with open(tmp, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(FIELDS)
        for day in sorted(days):
            w.writerow([day] + [days[day][k] for k in FIELDS[1:]])
    os.replace(tmp, KEPT)


def main():
    args = sys.argv[1:]
    days = load()
    days.update(from_logs())  # the logs are the fuller count for the days they still hold
    try:
        save(days)
    except OSError as err:
        print(f"(Couldn't save the totals: {err}. Run it with sudo.)", file=sys.stderr)
    if "--save" in args:
        return
    n = next((int(a) for a in args if a.isdigit()), 30)
    shown = sorted(days)[-n:]
    print(f"deskwisp.com, every visitor (cookies or not). UTC days.\n")
    print(f"{'Day':<12}{'Visitors':>10}{'Page views':>12}{'Downloads':>11}{'Updates':>9}")
    for day in shown:
        d = days[day]
        print(f"{day:<12}{d['visitors']:>10}{d['page_views']:>12}{d['downloads']:>11}{d['updates']:>9}")
    if not shown:
        print("(Nothing yet: the log starts filling once install.sh has run.)")
    tot = lambda k, ds: sum(days[x][k] for x in ds)
    print(f"\n{'Shown':<12}{tot('visitors', shown):>10}{tot('page_views', shown):>12}{tot('downloads', shown):>11}{tot('updates', shown):>9}")
    print(f"{'All time':<12}{tot('visitors', days):>10}{tot('page_views', days):>12}{tot('downloads', days):>11}{tot('updates', days):>9}")
    print("\nVisitors are counted per day, so 'All time' visitors counts a returning visitor once a day.")


if __name__ == "__main__":
    main()
