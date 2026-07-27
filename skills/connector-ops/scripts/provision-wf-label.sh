#!/usr/bin/env bash
set -euo pipefail

: "${LINEAR_PROXY_URL:=http://127.0.0.1:3100/proxy/graphql}"
: "${LINEAR_OAUTH_TOKEN:=}"

if [ $# -lt 2 ]; then
  echo "Usage: $0 <team-key> <label-name>"
  echo "Example: $0 INF wf:dev-impl"
  echo ""
  echo "Provisions a label on the given team via the Linear proxy."
  exit 1
fi

TEAM_KEY="$1"
LABEL_NAME="$2"

if [ -z "$LINEAR_OAUTH_TOKEN" ]; then
  AGENT_ID="${OPENCLAW_MCP_AGENT_ID:-${OPENCLAW_AGENT_NAME:-grover}}"
  SECRET_PATH="${OPENCLAW_CONFIG_DIR:-$HOME/.openclaw}/workspace/$AGENT_ID/.secrets/linear.env"
  if [ -f "$SECRET_PATH" ]; then
    # shellcheck disable=SC1090
    set -a; . "$SECRET_PATH"; set +a
  fi
fi

if [ -z "$LINEAR_OAUTH_TOKEN" ]; then
  echo "ERROR: LINEAR_OAUTH_TOKEN not set." >&2
  exit 1
fi

echo "=== Provision Label ==="
echo "Team: $TEAM_KEY"
echo "Label: $LABEL_NAME"
echo ""

PROXY_GRAPHQL_URL="$LINEAR_PROXY_URL"
case "$PROXY_GRAPHQL_URL" in
  */graphql) ;;
  */) PROXY_GRAPHQL_URL="${PROXY_GRAPHQL_URL}graphql" ;;
  *) PROXY_GRAPHQL_URL="${PROXY_GRAPHQL_URL}/graphql" ;;
esac

# First, resolve the team ID from the key.
TEAM_RESPONSE=$(curl -sf -X POST "$PROXY_GRAPHQL_URL" \
  -H "Authorization: $LINEAR_OAUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"query\": \"query { teams(filter: { key: { eq: \\\"$TEAM_KEY\\\" } }, first: 1) { nodes { id name key labels(first: 250) { nodes { id name } } } } }\"}" 2>&1)

TEAM_ID=$(echo "$TEAM_RESPONSE" | python3 -c "import sys,json; nodes=json.load(sys.stdin)['data']['teams']['nodes']; print(nodes[0]['id'] if nodes else '')" 2>/dev/null) || {
  echo "ERROR: Could not resolve team key '$TEAM_KEY'. Response:" >&2
  echo "$TEAM_RESPONSE" >&2
  exit 1
}

if [ -z "$TEAM_ID" ]; then
  echo "ERROR: Could not resolve team key '$TEAM_KEY'. Response:" >&2
  echo "$TEAM_RESPONSE" >&2
  exit 1
fi

echo "Team ID: $TEAM_ID"

EXISTING_LABEL_ID=$(echo "$TEAM_RESPONSE" | LABEL_NAME="$LABEL_NAME" python3 -c "import os,sys,json; data=json.load(sys.stdin); nodes=data['data']['teams']['nodes']; labels=nodes[0]['labels']['nodes'] if nodes else []; print(next((l['id'] for l in labels if l['name']==os.environ['LABEL_NAME']), ''))" 2>/dev/null)
if [ -n "$EXISTING_LABEL_ID" ]; then
  echo ""
  echo "Label already exists: $EXISTING_LABEL_ID"
  exit 0
fi

# Create the label
LABEL_RESPONSE=$(curl -sf -X POST "$PROXY_GRAPHQL_URL" \
  -H "Authorization: $LINEAR_OAUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"query\": \"mutation { issueLabelCreate(input: { name: \\\"$LABEL_NAME\\\", teamId: \\\"$TEAM_ID\\\" }) { success issueLabel { id name } } }\"}" 2>&1)

echo ""
echo "$LABEL_RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$LABEL_RESPONSE"
