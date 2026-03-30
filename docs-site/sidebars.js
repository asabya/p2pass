/** @type {import('@docusaurus/plugin-content-docs').SidebarsConfig} */
const sidebars = {
  docsSidebar: [
    'intro',
    'getting-started',
    {
      type: 'category',
      label: 'Architecture',
      items: ['architecture/identity', 'architecture/p2p-stack', 'architecture/storacha-backup'],
    },
    {
      type: 'category',
      label: 'Guides',
      items: ['guides/react-wrapper', 'guides/device-linking'],
    },
    'api-reference',
  ],
};

module.exports = sidebars;
