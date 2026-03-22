# CoachCarter

An automated triathlon coaching system. Syncs workouts from Garmin, scores them against a training plan, collects feedback over email, and uses Claude AI to generate coaching reports — all presented in a static dashboard.

**[View Dashboard →](https://nayankote.github.io/coachCarter/)**

---

## How It Works

1. **Sync** — run `node scripts/sync-garmin.js` locally to pull new Garmin activities
2. **Analyse** — FIT files are parsed, metrics extracted, and scored against the training plan automatically
3. **Feedback** — an email is sent asking how the session felt; the athlete replies
4. **Coach** — Claude reads the reply and generates a coaching report, emailed back
5. **Review** — every Sunday, a weekly summary is generated and emailed
6. **Dashboard** — GitHub Actions rebuilds the static dashboard every 30 minutes

---

## Stack

| Layer | Technology |
|---|---|
| Data source | Garmin Connect (unofficial API) |
| Database | Supabase Postgres |
| File storage | Supabase Storage |
| Email | AgentMail |
| AI | Anthropic Claude (`claude-sonnet-4-6`) |
| Frontend | Static HTML/JS (GitHub Pages) |
| CI | GitHub Actions |

---

## Repo Structure

```
scripts/
  sync-garmin.js         # Pull new activities from Garmin
  analyze-workout.js     # Parse FIT, score compliance, send feedback email
  finalize-coaching.js   # Generate coaching report after athlete reply
  weekly-review.js       # Weekly summary email (runs Sunday via CI)
  build-frontend-data.js # Rebuild workouts.json for the dashboard
  update-plan.js         # Validate plan.json structure

lib/
  garmin.js              # Garmin Connect client + dedup logic
  fit-parser.js          # FIT file parsing + metric extraction
  compliance.js          # Compliance scoring (0–100)
  coaching.js            # Claude AI calls
  email.js               # AgentMail send
  email-templates.js     # Sport-specific email copy
  plan.js                # Training plan loader + session matching
  keychain.js            # Secret resolution (Keychain / env vars)
  supabase.js            # Supabase client singleton

docs/
  index.html             # Dashboard (GitHub Pages)
  workouts.json          # Generated — do not edit manually
  plan.json              # Generated — do not edit manually
  ARCHITECTURE.md        # System design reference
  ROADMAP.md             # What's shipped, what's next, decisions log

plan.json                # Training plan definition (source of truth)
.github/workflows/       # CI: frontend build, weekly review, manual sync
```

---

## Local Setup

**Prerequisites:** Node.js 20+, a Supabase project, an AgentMail inbox, an Anthropic API key, a Garmin account.

```bash
git clone https://github.com/nayankote/coachCarter.git
cd coachCarter
npm install
cp .env.example .env    # fill in SUPABASE_URL, ATHLETE_EMAIL, AGENTMAIL_INBOX
```

Add secrets to macOS Keychain:

```bash
security add-generic-password -s "coachcarter-garmin"    -a "coachcarter-garmin"    -w <garmin_password>
security add-generic-password -s "coachcarter-anthropic" -a "coachcarter-anthropic" -w <anthropic_api_key>
security add-generic-password -s "coachcarter-agentmail" -a "coachcarter-agentmail" -w <agentmail_api_key>
security add-generic-password -s "coachcarter-supabase"  -a "coachcarter-supabase"  -w <supabase_service_key>
```

Sync your latest Garmin activities:

```bash
node scripts/sync-garmin.js
```

---

## GitHub Actions Secrets Required

| Secret | Purpose |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Supabase service role key |
| `AGENTMAIL_INBOX` | AgentMail inbox ID |
| `AGENTMAIL_API_KEY` | AgentMail API key |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `ATHLETE_EMAIL` | Where feedback emails are sent |

---

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — system design, components, data flow
- [Roadmap](docs/ROADMAP.md) — what's shipped, what's next, key decisions
