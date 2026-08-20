#!/usr/bin/env bash
# Compare the live `github-deployer` Role against k8s/rbac-github-deployer.yaml.
#
# The file is the source of truth for CI's own permissions, but it is applied by
# hand — the deployer has no rights on `roles`, and one that could widen its own
# access would not be restricted. So nothing keeps the two in step automatically,
# and they have already drifted once: the `batch` rules were added with `kubectl
# edit`, which left the file describing a Role with no cronjob access at all.
# Re-applying it would silently have removed the ability to patch either CronJob.
#
# **Warns, never fails.** The deploy gate exists to keep bad code out of
# production; coupling it to permission drift would block an unrelated deploy for
# something no code change caused. A GitHub warning annotation is visible in the
# run summary, which is where someone will actually see it.
#
# Usage: scripts/check-rbac-drift.sh [path-to-manifest]
set -uo pipefail

MANIFEST="${1:-k8s/rbac-github-deployer.yaml}"
ROLE=github-deployer

# GitHub renders these in the run summary; outside Actions they are just prefixes.
warn() { printf '::warning title=RBAC drift::%s\n' "$*"; }
note() { printf '%s\n' "$*"; }

[ -f "$MANIFEST" ] || { warn "$MANIFEST not found — skipping the drift check."; exit 0; }

live="$(kubectl get "role/$ROLE" -o json 2>/dev/null)"
if [ -z "$live" ]; then
  # Expected until the self-read grant in the manifest has been applied by hand.
  note "Cannot read role/$ROLE — the self-read grant is not applied yet."
  note "Apply it with an RBAC-capable kubeconfig: kubectl apply -f $MANIFEST"
  exit 0
fi

# Compare rules only. Everything else on a live object — resourceVersion, uid,
# managedFields, the last-applied annotation — differs by construction and says
# nothing about whether the permissions match.
diff_out="$(
  python3 - "$MANIFEST" <<'PY' 2>&1
import json, sys, subprocess

try:
    import yaml
except ImportError:
    print("SKIP: PyYAML unavailable")
    raise SystemExit(0)


def normalise(rules):
    """Sort every level, so ordering differences are not reported as drift."""
    out = []
    for rule in rules or []:
        out.append(
            {
                key: sorted(rule.get(key) or [])
                for key in ("apiGroups", "resources", "resourceNames", "verbs")
                if rule.get(key)
            }
        )
    return sorted(out, key=lambda r: json.dumps(r, sort_keys=True))


with open(sys.argv[1]) as fh:
    wanted = next(
        d for d in yaml.safe_load_all(fh) if d and d.get("kind") == "Role"
    )

live = json.loads(
    subprocess.run(
        ["kubectl", "get", "role/github-deployer", "-o", "json"],
        capture_output=True, text=True, check=True,
    ).stdout
)

a, b = normalise(wanted.get("rules")), normalise(live.get("rules"))
if a == b:
    print("MATCH")
    raise SystemExit(0)

print("DRIFT")
only_file = [r for r in a if r not in b]
only_live = [r for r in b if r not in a]
for rule in only_file:
    print(f"  in the file but not in the cluster: {json.dumps(rule, sort_keys=True)}")
for rule in only_live:
    print(f"  in the cluster but not in the file: {json.dumps(rule, sort_keys=True)}")
PY
)"

case "$diff_out" in
  MATCH*)
    note "role/$ROLE matches $MANIFEST."
    ;;
  SKIP*)
    note "$diff_out"
    ;;
  DRIFT*)
    warn "role/$ROLE no longer matches $MANIFEST. Applying the file as-is would change CI's permissions."
    note "$diff_out"
    ;;
  *)
    note "Could not compare: $diff_out"
    ;;
esac

exit 0
