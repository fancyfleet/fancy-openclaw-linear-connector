import { createLogger, componentLogger } from "../logger.js";
const log = componentLogger(createLogger(), "lifecycle-linear");
export function loadLinearToken() {
    return (process.env.LINEAR_DEVELOPER_TOKEN ??
        process.env.LINEAR_API_KEY ??
        process.env.LINEAR_OAUTH_TOKEN ??
        null);
}
const WATCHDOG_TEAM_KEYS = new Set(["AI", "FCY", "ILL", "LIFE"]);
const OPEN_STATES = new Set(["To Do", "Thinking", "Doing"]);
function linearAuthHeader(token) {
    return /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
}
function extractAgentId(delegateName) {
    return delegateName.trim().split(/\s+/)[0].toLowerCase();
}
export async function fetchDelegatedOpenIssues(token) {
    const results = [];
    let after = null;
    const now = Date.now();
    while (true) {
        const afterClause = after ? `, after: "${after}"` : "";
        const query = `
      query DelegatedOpenIssues {
        issues(
          filter: {
            state: { type: { in: ["unstarted", "started"] } }
            team: { key: { in: ["AI", "FCY", "ILL", "LIFE"] } }
            delegate: { name: { neq: "" } }
          }
          first: 100${afterClause}
        ) {
          nodes {
            id
            identifier
            updatedAt
            priority
            state { name }
            delegate { name }
            assignee { name }
            team { id key }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;
        const response = await fetch("https://api.linear.app/graphql", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: linearAuthHeader(token),
            },
            body: JSON.stringify({ query }),
        });
        if (!response.ok) {
            log.error(`fetchDelegatedOpenIssues failed: HTTP ${response.status}`);
            break;
        }
        const body = (await response.json());
        if (body.errors?.length) {
            log.error(`fetchDelegatedOpenIssues GraphQL errors: ${body.errors.map((e) => e.message).join("; ")}`);
            break;
        }
        const issues = body.data?.issues;
        if (!issues)
            break;
        for (const node of issues.nodes) {
            const teamKey = node.team?.key ?? "";
            if (!WATCHDOG_TEAM_KEYS.has(teamKey))
                continue;
            if (!node.delegate?.name)
                continue;
            const stateName = node.state?.name ?? "unknown";
            if (!OPEN_STATES.has(stateName))
                continue;
            results.push({
                identifier: node.identifier,
                uuid: node.id,
                teamId: node.team?.id ?? "",
                state: stateName,
                delegateAgentId: extractAgentId(node.delegate.name),
                delegateName: node.delegate.name,
                assigneeName: node.assignee?.name ?? null,
                updatedAt: node.updatedAt,
                ageMs: now - new Date(node.updatedAt).getTime(),
                priority: node.priority ?? 0,
            });
        }
        if (!issues.pageInfo.hasNextPage || !issues.pageInfo.endCursor)
            break;
        after = issues.pageInfo.endCursor;
    }
    return results;
}
// Cache team → "To Do" state UUID per process lifetime
const todoStateCache = new Map();
export async function resetTicketToTodo(issueUuid, teamId, token) {
    let todoStateId = todoStateCache.get(teamId);
    if (!todoStateId) {
        const stateQuery = `
      query TeamStates($teamId: String!) {
        team(id: $teamId) {
          states { nodes { id name } }
        }
      }
    `;
        const stateResponse = await fetch("https://api.linear.app/graphql", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: linearAuthHeader(token),
            },
            body: JSON.stringify({ query: stateQuery, variables: { teamId } }),
        });
        if (!stateResponse.ok) {
            log.error(`resetTicketToTodo: failed to fetch team states (HTTP ${stateResponse.status})`);
            return false;
        }
        const stateBody = (await stateResponse.json());
        if (stateBody.errors?.length) {
            log.error(`resetTicketToTodo: team state query errors: ${stateBody.errors.map((e) => e.message).join("; ")}`);
            return false;
        }
        const states = stateBody.data?.team?.states?.nodes ?? [];
        const todoState = states.find((s) => s.name.toLowerCase() === "to do");
        if (!todoState) {
            log.error(`resetTicketToTodo: could not find "To Do" state for team ${teamId}`);
            return false;
        }
        todoStateId = todoState.id;
        todoStateCache.set(teamId, todoStateId);
    }
    const mutation = `
    mutation UpdateIssueState($id: String!, $stateId: String!) {
      issueUpdate(id: $id, input: { stateId: $stateId }) {
        success
      }
    }
  `;
    const response = await fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            authorization: linearAuthHeader(token),
        },
        body: JSON.stringify({ query: mutation, variables: { id: issueUuid, stateId: todoStateId } }),
    });
    if (!response.ok) {
        log.error(`resetTicketToTodo: mutation failed (HTTP ${response.status}) for issue ${issueUuid}`);
        return false;
    }
    const body = (await response.json());
    if (body.errors?.length) {
        log.error(`resetTicketToTodo: mutation errors for ${issueUuid}: ${body.errors.map((e) => e.message).join("; ")}`);
        return false;
    }
    return body.data?.issueUpdate?.success === true;
}
export async function postTicketComment(issueUuid, body, token) {
    const mutation = `
    mutation CreateComment($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) {
        success
      }
    }
  `;
    const response = await fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            authorization: linearAuthHeader(token),
        },
        body: JSON.stringify({ query: mutation, variables: { issueId: issueUuid, body } }),
    });
    if (!response.ok) {
        log.warn(`postTicketComment: HTTP ${response.status} for issue ${issueUuid}`);
        return;
    }
    const result = (await response.json());
    if (result.errors?.length) {
        log.warn(`postTicketComment: errors for ${issueUuid}: ${result.errors.map((e) => e.message).join("; ")}`);
    }
}
//# sourceMappingURL=linear-query.js.map