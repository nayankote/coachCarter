Sync new workouts from Garmin Connect.

Run from the project root:

```bash
node scripts/sync-garmin.js
```

This will:
1. Fetch new activities from Garmin Connect (pages newest-first, stops when a full page is already known)
2. Deduplicate concurrent bike recordings by time-window overlap (Zwift + watch)
3. Upload FIT files to Supabase Storage
4. Insert new workout rows (status: synced)
5. Immediately call analyze-workout for each new activity

Report how many activities were synced and flag any errors. If Garmin auth fails with ECONNRESET, it's a transient network issue — just re-run.

## Credentials
- `SUPABASE_URL` from `.env`
- Supabase service key, Garmin password, AgentMail API key from macOS Keychain (`coachcarter-supabase`, `coachcarter-garmin`, `coachcarter-agentmail`)
- In CI: all secrets come from GitHub Actions Secrets
