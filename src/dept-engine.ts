export type DeptOutputClass =
  | "owned-infra"
  | "product-backlog-proposal"
  | "standards-proposal";

export interface DeptProposal {
  class: DeptOutputClass;
  title: string;
  team: string;
  priority?: string;
  sprint?: string;
  state?: string;
}

export interface DeptEngineOutputPlanInput {
  department: string;
  cycle: number;
  foundation: {
    milestone: string;
    met: boolean;
  };
  proposals: DeptProposal[];
}

export interface PlannedDeptChild extends DeptProposal {
  barrier: boolean;
  labels: string[];
}

const UNLOCKED_OUTPUTS = new Set<DeptOutputClass>([
  "product-backlog-proposal",
  "standards-proposal",
]);

export function planDeptEngineOutputs(input: DeptEngineOutputPlanInput): { children: PlannedDeptChild[] } {
  const locked = input.proposals.filter((proposal) => UNLOCKED_OUTPUTS.has(proposal.class));
  if (!input.foundation.met && locked.length > 0) {
    const classes = [...new Set(locked.map((proposal) => proposal.class))].join(", ");
    throw new Error(
      `foundation milestone ${input.foundation.milestone} must be met before emitting ${classes}`,
    );
  }

  const provenance = `dept-proposed: ${input.department}, cycle ${input.cycle}`;
  const children = input.proposals.map((proposal): PlannedDeptChild => {
    const child: PlannedDeptChild = {
      ...proposal,
      barrier: proposal.class === "owned-infra",
      labels: [provenance, `dept-output:${proposal.class}`],
    };

    if (proposal.team !== input.department) {
      delete child.priority;
      delete child.sprint;
      delete child.state;
    }

    return child;
  });

  return { children };
}

export interface DeptOwnedInfraTerminalInput {
  department: string;
  artifactType: string;
  checks?: { tests?: string };
  pullRequest?: { merged?: boolean };
  headReview?: {
    reviewer?: string;
    approved?: boolean;
    authoredByDepartmentHead?: boolean;
  };
}

export function isDeptOwnedInfraTerminal(input: DeptOwnedInfraTerminalInput): boolean {
  if (input.department === "ENG" && input.artifactType === "pull-request") {
    return input.checks?.tests === "green" && input.pullRequest?.merged === true;
  }

  return input.headReview?.approved === true && input.headReview.authoredByDepartmentHead === true;
}
