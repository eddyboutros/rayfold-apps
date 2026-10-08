# documents-ui

The documents panel, owned by the team that owns the documents service. Exposes `./Documents` and `./Shared` (the
page a share link opens) to the shell. Its sign-offs tab talks to the approvals service with a second client.

```sh
npm install
npx ng serve --port 4202      # the panel on its own, against documents :4001, workspace :4002 and approvals :4004
npm test -- --watch=false     # its specs, against the services' own schemas, in process
```

The documents client stays on HTTP because it uploads, which the WebSocket does not carry. See
[../README.md](../README.md).
