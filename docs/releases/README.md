# What's new in each version

One file per version (`v0.1.0.md`): one to five lines starting with "- ", each 12 words or fewer, on
what a user notices. `scripts/release-win.sh <version>` reads `v<version>.md` and puts its lines in
`/download/win/latest.json`, which the app shows as "What's new" in its update notice, in About and on
the update screen.

Write for the people using Deskwisp: what they can do now, or what works better. Plain words: no
branch names, file paths or settings, and no names of people.

```markdown
- Deskwisp updates itself, and shows what's new.
- About Deskwisp, with Check for updates.
```
