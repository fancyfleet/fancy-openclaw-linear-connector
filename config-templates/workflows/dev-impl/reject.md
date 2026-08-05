# dev-impl v20 reject behavior

Use `reject` for every backward move in the dev-impl workflow.

`request-changes` is removed in v20; use `reject` from code-review to return
the ticket to implementation.

`ac-fail` is removed in v20; use `reject` from ac-validate to return the ticket
to implementation.

Implementation may also use `reject` to return to write-tests when the failing
test coverage is not ready for implementation.
