import { getAccessToken } from "./agents.js";
import { issueIdentifierFromSessionKey } from "./linear-actionable.js";
import { createLogger, componentLogger } from "./logger.js";
const log = componentLogger(createLogger(), "linear-session-failure");
const LINEAR_API = "https://api.linear.app/graphql";
function authHeader(token) {
    return /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
}
async function linearGraphql(agentId, query, variables) {
    const token = getAccessToken(agentId) ?? process.env.LINEAR_OAUTH_TOKEN ?? process.env.LINEAR_API_KEY;
    if (!token) {
        log.warn(`Cannot update Linear after silent dispatch failure for ${agentId}: no token`);
        return null;
    }
    const response = await fetch(LINEAR_API, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            authorization: authHeader(token),
        },
        body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) {
        log.warn(`Linear update failed for ${agentId}: HTTP ${response.status}`);
        return null;
    }
    const body = (await response.json());
    if (body.errors?.length) {
        log.warn(`Linear update errored for ${agentId}: ${body.errors.map((e) => e.message).join("; ")}`);
        return null;
    }
    return body.data ?? null;
}
export async function recordSilentDispatchFailure(params) {
    const identifier = issueIdentifierFromSessionKey(params.ticketId);
    const issueData = await linearGraphql(params.agentId, `query IssueForSilentDispatchFailure($id: String!) {
      issue(id: $id) {
        id
        state { id name type }
        team { states { nodes { id name type } } }
      }
    }`, { id: identifier });
    const issue = issueData?.issue;
    if (!issue?.id) {
        log.warn(`Cannot update Linear after silent dispatch failure: issue ${identifier} not found`);
        return;
    }
    const todoState = issue.team?.states?.nodes?.find((state) => {
        const name = state.name?.toLowerCase();
        return state.type === "unstarted" && (name === "to do" || name === "todo");
    }) ?? issue.team?.states?.nodes?.find((state) => state.type === "unstarted");
    if (todoState?.id && issue.state?.id !== todoState.id) {
        await linearGraphql(params.agentId, `mutation ResetIssueState($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success }
      }`, { id: issue.id, input: { stateId: todoState.id } });
    }
    const body = params.exhausted
        ? `Connector detected no Linear activity after ${params.maxAttempts} dispatch retry attempt(s). Retry cap exhausted; manual intervention is needed before this ticket is re-dispatched.`
        : `Connector detected no Linear activity within the first-activity timeout after dispatch attempt ${params.attempt}/${params.maxAttempts}. Re-dispatching now.`;
    await linearGraphql(params.agentId, `mutation CommentOnSilentDispatchFailure($input: CommentCreateInput!) {
      commentCreate(input: $input) { success comment { id url } }
    }`, { input: { issueId: issue.id, body } });
}
//# sourceMappingURL=linear-session-failure.js.map