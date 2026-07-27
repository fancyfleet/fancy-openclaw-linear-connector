# XFN Label Provisioning

Cross-functional demotion stamps `cross-functional-request` and `xfn:<requester-dimension>` on the target issue before routing it back to Backlog. Those labels must resolve through the same team-scoped lookup path that writes `labelIds` to Linear.

For new `xfn:*` dimensions, provision the label on every target team that can receive cross-functional work. Teams that already own the label directly should keep using that team-owned ID. If a sub-team such as LIF returns a parent-owned inherited label and direct creation fails with `conflicting inherited label`, do not forward the inherited parent label ID in issue mutations; Linear rejects it as belonging to the wrong team.

The connector repair path is automated in `linear-helpers.findOrCreateLabel`: it ignores inherited parent-team IDs, attempts direct team creation, and on an inherited-label conflict creates a workspace-level label by omitting `teamId`. Workspace-level labels are accepted by sub-teams and keep future `xfn:*` dimensions from stranding a single sub-team silently.

When adding or auditing an `xfn:*` dimension:

1. Run the demotion path against each target team and confirm the resulting `labelIds` include `cross-functional-request` plus the requested `xfn:*` label.
2. Confirm any returned label ID is either owned by the target team or workspace-level, never a parent team's inherited ID.
3. If workspace-level creation is refused because the name already exists elsewhere, archive or migrate the conflicting team-level label in Linear, then retry so the workspace-level label is visible to LIF and other sub-teams.
