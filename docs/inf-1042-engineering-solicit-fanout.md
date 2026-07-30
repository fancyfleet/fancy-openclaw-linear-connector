# INF-1042 Engineering Solicit Fanout

Department-engine `solicitations` fanout must not mint Engineering-role solicitations as Design-scoped `wf:task` children. When a `wf:task` solicitation spec contains Engineering recipients or roles such as Noah, Sage, Igor, tdd, `react-native`, `web`, `backend`, `test-author`, or `owned-resource`, the fanout now refuses before `issueCreate`.

Live recovery for already-minted `ENG-18`..`ENG-22`: do not advance the Backlog/null-delegate `wf:task` xfn stubs. Recreate or reroute each request through the Engineering/dev-impl entry path with the intended delegate mapping: `ENG-18` Noah, `ENG-19` Sage, `ENG-20` Igor, `ENG-21` tdd, and `ENG-22` Igor. Once the replacement children exist, remove or close the inert `wf:task` stubs so the parent barrier observes the Engineering-scoped children instead.
