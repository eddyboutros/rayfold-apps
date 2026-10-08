# catalogue-ui

The catalogue page, owned by the team that owns the catalogue service. Exposes `./Catalogue` to the shell.

```sh
npm install
npx ng serve --port 4203      # the page on its own, against the catalogue service on :4003 and feedback on :4005
npm test -- --watch=false     # its specs, against the catalogue's and the feedback service's own schemas
```

The search returns a union and the list an interface; one shape asks for what it wants of each kind with `...on`
and each card reads its own fields. Browsing is numbered pages (`@page(offset)`); an article's body is `@lazy` and
arrives after its title. An article's page publishes it to the help centre and shows what its readers said, from the
feedback service, with a second client provided around that one component (`src/app/help-feedback.ts`).
