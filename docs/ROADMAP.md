# CoachCarter — Roadmap

> Feature requests and bugs are tracked as [GitHub Issues](https://github.com/nayankote/coachCarter/issues).
> This document captures the bigger picture: what's shipped, what's next, and what's being considered.

---

## Shipped

- Garmin sync via ID-set comparison (no brittle timestamps)
- Multi-sport FIT splitting (70.3 Ironman → 5 separate session rows)
- Per-sport metric extraction (bike power/NP/TSS, run pace/HR, swim pace/sTSS)
- Compliance scoring (weighted pass/fail vs plan targets)
- Email feedback loop via AgentMail (send → athlete replies → webhook)
- Claude coaching reports per workout and per week
- Static dashboard (GitHub Pages) with vertical week scroll, card colours, status ticks
- Duplicate bike dedup using time-window overlap (Zwift + watch same ride)
- Row Level Security enabled on all Supabase tables
- Frontend data rebuilt automatically every 30 min via GitHub Actions

---

## Up Next

> Features confirmed for the next development push, roughly in priority order.

_To be filled in — share your feature list and these will be broken into GitHub Issues._

---

## Considering

> Ideas under evaluation. Not committed.

- **Garmin sync trigger**: automated sync without relying on datacenter IPs (options: local daemon, Shortcuts/Automator on Mac, or a self-hosted runner)
- **Plan editor UI**: edit `plan.json` from the dashboard instead of manually
- **Multi-athlete support**: parameterise athlete config so the system can run for more than one person
- **Trend charts**: TSS load, compliance %, and HR drift over time on the dashboard

---

## Decisions Log

| Date | Decision | Reason |
|---|---|---|
| 2026-03 | Garmin sync moved from GitHub Actions to local Mac | Datacenter IPs rate-limited/blocked by Garmin |
| 2026-03 | Multi-sport split using synthetic IDs (`parentId * 10 + index`) | Avoids schema migration; `sessionIndex` recoverable via `% 10` |
| 2026-03 | Bike dedup via time-window overlap, not name matching or duration | Name-based failed on custom Zwift names; duration-based blocked back-to-back rides |
| 2026-03 | Frontend fully static (no browser → Supabase calls) | Keeps service key server-side only; simpler security model |
