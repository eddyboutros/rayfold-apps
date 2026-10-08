# workspace-ui

The workspace panels, owned by the team that owns the workspace service. Exposes `./Feed`, `./Issues`, `./Chat`,
`./Notifications`, `./People`, `./Quick` (the command palette's "do" entries) and `./ProjectSettings` to the shell.

```sh
npm install
npx ng serve --port 4201      # the panels on their own, against workspace :4002 and documents :4001
npm test -- --watch=false     # its specs, against the services' own schemas, in process
```

Every panel's subscriptions share one WebSocket, `/api/workspace/rayfold/ws`, because a browser allows six HTTP
connections per host. See [../README.md](../README.md).
