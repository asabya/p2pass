// @ts-check

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'p2p-passkeys',
  tagline: 'P2P Passkey-Based DID Identities with Storacha Backup',
  favicon: 'img/favicon.ico',

  url: 'https://asabya.github.io',
  baseUrl: '/p2p-passkeys/guide/',

  organizationName: 'asabya',
  projectName: 'p2p-passkeys',

  onBrokenLinks: 'throw',
  onBrokenAnchors: 'warn',

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  markdown: {
    mermaid: true,
  },

  themes: ['@docusaurus/theme-mermaid'],

  presets: [
    [
      'classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          sidebarPath: './sidebars.js',
          editUrl: 'https://github.com/asabya/p2p-passkeys/tree/master/docs-site/',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      }),
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      navbar: {
        title: 'p2p-passkeys',
        items: [
          {
            type: 'docSidebar',
            sidebarId: 'docsSidebar',
            position: 'left',
            label: 'Docs',
          },
          {
            href: 'https://asabya.github.io/p2p-passkeys/demo/',
            position: 'left',
            label: 'Demo',
          },
          {
            href: 'https://github.com/asabya/p2p-passkeys',
            label: 'GitHub',
            position: 'right',
          },
        ],
      },
      footer: {
        style: 'dark',
        links: [
          {
            title: 'Docs',
            items: [
              { label: 'Introduction', to: '/docs/intro' },
              { label: 'Getting Started', to: '/docs/getting-started' },
              { label: 'API Reference', to: '/docs/api-reference' },
            ],
          },
          {
            title: 'Built On',
            items: [
              { label: 'libp2p', href: 'https://libp2p.io' },
              { label: 'OrbitDB', href: 'https://orbitdb.org' },
              { label: 'Storacha', href: 'https://storacha.network' },
              { label: 'WebAuthn', href: 'https://www.w3.org/TR/webauthn-2/' },
            ],
          },
          {
            title: 'More',
            items: [
              { label: 'GitHub', href: 'https://github.com/asabya/p2p-passkeys' },
              { label: 'Demo', href: 'https://asabya.github.io/p2p-passkeys/demo/' },
            ],
          },
        ],
        copyright: 'p2p-passkeys — MIT License',
      },
      prism: {
        theme: require('prism-react-renderer').themes.github,
        darkTheme: require('prism-react-renderer').themes.dracula,
        additionalLanguages: ['bash', 'json'],
      },
      mermaid: {
        theme: { light: 'neutral', dark: 'dark' },
      },
    }),
};

module.exports = config;
