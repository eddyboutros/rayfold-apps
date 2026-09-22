# catalogue-ui

The catalogue page, owned by the team that owns the catalogue service. Exposes `./Catalogue` to the shell.

```sh
npm install
npx ng serve --port 4203      # the page on its own, against the catalogue service on :4003
```

The search returns a union and the list an interface; one shape asks for what it wants of each kind with `...on`
and each card reads its own fields. Browsing is numbered pages (`@page(offset)`); an article's body is `@lazy` and
arrives after its title.
