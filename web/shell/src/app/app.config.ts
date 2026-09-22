import { provideZonelessChangeDetection, type ApplicationConfig } from "@angular/core";

/**
 * The shell provides no Rayfold client. Each remote provides its own, for the service it was built against — a
 * page assembled from several teams' work talks to several services, and the shell should not have to know which.
 */
export const appConfig: ApplicationConfig = {
  providers: [provideZonelessChangeDetection()],
};
