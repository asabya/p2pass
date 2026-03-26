import React from 'react';
import ComponentCreator from '@docusaurus/ComponentCreator';

export default [
  {
    path: '/p2p-passkeys/guide/docs',
    component: ComponentCreator('/p2p-passkeys/guide/docs', '8f3'),
    routes: [
      {
        path: '/p2p-passkeys/guide/docs',
        component: ComponentCreator('/p2p-passkeys/guide/docs', '243'),
        routes: [
          {
            path: '/p2p-passkeys/guide/docs',
            component: ComponentCreator('/p2p-passkeys/guide/docs', '4e2'),
            routes: [
              {
                path: '/p2p-passkeys/guide/docs/api-reference',
                component: ComponentCreator('/p2p-passkeys/guide/docs/api-reference', '3a7'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/p2p-passkeys/guide/docs/architecture/identity',
                component: ComponentCreator('/p2p-passkeys/guide/docs/architecture/identity', 'db2'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/p2p-passkeys/guide/docs/architecture/p2p-stack',
                component: ComponentCreator('/p2p-passkeys/guide/docs/architecture/p2p-stack', '318'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/p2p-passkeys/guide/docs/architecture/storacha-backup',
                component: ComponentCreator('/p2p-passkeys/guide/docs/architecture/storacha-backup', '92b'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/p2p-passkeys/guide/docs/getting-started',
                component: ComponentCreator('/p2p-passkeys/guide/docs/getting-started', 'fbd'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/p2p-passkeys/guide/docs/guides/device-linking',
                component: ComponentCreator('/p2p-passkeys/guide/docs/guides/device-linking', '6ca'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/p2p-passkeys/guide/docs/guides/react-wrapper',
                component: ComponentCreator('/p2p-passkeys/guide/docs/guides/react-wrapper', 'e80'),
                exact: true,
                sidebar: "docsSidebar"
              },
              {
                path: '/p2p-passkeys/guide/docs/intro',
                component: ComponentCreator('/p2p-passkeys/guide/docs/intro', 'd8d'),
                exact: true,
                sidebar: "docsSidebar"
              }
            ]
          }
        ]
      }
    ]
  },
  {
    path: '/p2p-passkeys/guide/',
    component: ComponentCreator('/p2p-passkeys/guide/', 'e22'),
    exact: true
  },
  {
    path: '*',
    component: ComponentCreator('*'),
  },
];
