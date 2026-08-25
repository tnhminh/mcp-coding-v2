# RUNBOOK

## Local verification failure
1. capture failing command and output
2. fix root cause
3. rerun targeted check
4. rerun `npm run check`
5. update STATUS/HANDOFF/CHANGELOG only with verified results

## HTTP local health
Run `npm run dev:http`, query `/health/live` and `/health/ready`, verify non-sensitive JSON and expected status code.
