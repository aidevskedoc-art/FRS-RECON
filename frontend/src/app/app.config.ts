import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideHttpClient, withFetch } from '@angular/common/http';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { providePrimeNG } from 'primeng/config';

import { routes } from './app.routes';
import { FrsAiPreset } from './core/config/theme-preset';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding()),
    provideHttpClient(withFetch()),
    provideAnimationsAsync(),
    providePrimeNG({
      theme: {
        preset: FrsAiPreset,
        options: {
          darkModeSelector: '[data-theme="dark"]',
          cssLayer: {
            name: 'primeng',
            order: 'bootstrap, primeng, tailwind-base, tailwind-utilities',
          },
        },
      },
      ripple: true,
    }),
  ],
};
