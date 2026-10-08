# shell

The page: the rail, the project switcher, the theme, sign-in and the session, the settings, the guide and the
command palette. Owns no features and no client; it loads the remotes named in `public/federation.manifest.json` at
runtime. See [../README.md](../README.md).

```sh
npm install
npx ng serve --port 4200      # http://localhost:4200, with the remotes' dev servers and the services running
npm test -- --watch=false     # sign-in, the session, the rail, the keyboard and the settings
```

`proxy.conf.json` sends `/api/<service>` to the services `npm run dev` starts, `/remotes/<app>/` to each remote's dev
server, and `/help/` and `/api/help/` to the help centre's, so the page has one origin as it does behind the gateway.
