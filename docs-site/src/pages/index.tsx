import React from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';

function Hero() {
  return (
    <div style={{ textAlign: 'center', padding: '80px 20px 60px' }}>
      <h1 style={{ fontSize: '2.5rem', marginBottom: '16px' }}>p2p-passkeys</h1>
      <p style={{ fontSize: '1.2rem', color: 'var(--ifm-color-emphasis-700)', maxWidth: '600px', margin: '0 auto 32px' }}>
        Drop-in passkey authentication, decentralized identity, and encrypted backup for your app.
      </p>
      <div style={{ display: 'flex', gap: '12px', justifyContent: 'center', flexWrap: 'wrap' }}>
        <Link className="button button--primary button--lg" to="/docs/intro">
          Get Started
        </Link>
        <Link className="button button--secondary button--lg" href="https://asabya.github.io/p2p-passkeys/demo/">
          Live Demo
        </Link>
      </div>
    </div>
  );
}

const features = [
  {
    title: 'Passkey Authentication',
    description: 'WebAuthn biometric auth with auto-detection of Ed25519, P-256, or worker-derived keys.',
  },
  {
    title: 'P2P Device Linking',
    description: 'Link devices over libp2p with approval-based pairing. OrbitDB registry keeps everything in sync.',
  },
  {
    title: 'Storacha Backup',
    description: 'UCAN-delegated backup to Storacha decentralized storage with IPNS recovery manifest.',
  },
];

function Features() {
  return (
    <div style={{ padding: '40px 20px 80px' }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
        gap: '24px',
        maxWidth: '960px',
        margin: '0 auto',
      }}>
        {features.map((f) => (
          <div key={f.title} style={{
            padding: '24px',
            borderRadius: '8px',
            border: '1px solid var(--ifm-color-emphasis-200)',
          }}>
            <h3>{f.title}</h3>
            <p>{f.description}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <Layout title="Home" description="P2P Passkey-Based DID Identities with Storacha Backup">
      <Hero />
      <Features />
    </Layout>
  );
}
