# Ombot 9.9-10 Definition of Done

This checklist defines release readiness.

## Quality

- [ ] `npm run ci:quality` passing on main
- [ ] Coverage threshold >= 85% line and branch
- [ ] Protocol vector verification passing

## Security

- [ ] No open critical/high vulnerabilities
- [ ] Secrets not stored in repository files
- [ ] At-rest chatroom key encryption enabled in production
- [ ] Key rotation drill executed at least once per quarter

## Reliability

- [ ] Health, readiness, and metrics endpoints monitored
- [ ] Graceful shutdown tested in staging
- [ ] Middleware reconnection behavior validated under outage simulation

## Operations

- [ ] Deploy and rollback scripts validated in staging
- [ ] Runbook up to date
- [ ] Last GameDay report completed and reviewed

## SLO

- [ ] 30-day availability >= 99.95%
- [ ] MTTD < 5 minutes
- [ ] MTTR < 30 minutes
